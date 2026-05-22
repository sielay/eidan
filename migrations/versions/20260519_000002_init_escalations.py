"""init eidan.escalations table

Revision ID: 20260519000002
Revises: 20260519000001
Create Date: 2026-05-19

Phase 1 implementation of `docs/022 §3` — the minimum-viable
escalation envelope. A behaviour, plugin, or the loop itself can
record a structured "I'm blocked" row that the UI surfaces and the
operator (or a future agent) resolves.

The table is intentionally separate from ``eidan.events`` despite
§2.1's open question — escalations have severity, reason_class,
suggested_action, and a status lifecycle that don't fit cleanly
inside an event row, and folding them in conflates the two
semantics. Cheaper to keep them apart.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260519000002"
down_revision: str | None = "20260519000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "escalations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=True),
        # Severity tier from `docs/022 §1`. `low` queues for the
        # notification surface, `medium` interrupts the next turn,
        # `high` pages the operator out-of-band.
        sa.Column("severity", sa.Text(), nullable=False),
        # The pinned reason class from `docs/022 §1`. CHECK constraint
        # below; keeping the list short forces escalations to map onto
        # a known shape rather than free text.
        sa.Column("reason_class", sa.Text(), nullable=False),
        # Free-text or pinned-enum hint per `docs/022 §1`.
        sa.Column("suggested_action", sa.Text(), nullable=True),
        # Evidence pointers — message ids, llm_call ids, external trace
        # ids. JSONB so a future evidence shape can extend without
        # another migration.
        sa.Column(
            "evidence",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        # `pending` / `acknowledged` / `resolved` lifecycle (`docs/022
        # §4` reserved). Operator UI moves rows through these states.
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        # Free-form context the emitting agent attaches. The schema
        # itself stays small; surface-specific shape (e.g. the
        # behaviour id that emitted it) lives here.
        sa.Column(
            "metadata",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "resolved_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=True,
        ),
        sa.CheckConstraint(
            "severity IN ('low','medium','high')",
            name="escalations_severity_chk",
        ),
        sa.CheckConstraint(
            "reason_class IN ("
            "'missing_input','permission_denied','external_failure',"
            "'ambiguous_intent','over_budget','over_capacity',"
            "'unrecoverable_error','other'"
            ")",
            name="escalations_reason_chk",
        ),
        sa.CheckConstraint(
            "status IN ('pending','acknowledged','resolved')",
            name="escalations_status_chk",
        ),
        schema="eidan",
    )

    # Read paths: list pending escalations by user, newest first.
    op.create_index(
        "idx_escalations_user_pending",
        "escalations",
        ["user_id", sa.text("created_at DESC")],
        schema="eidan",
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index(
        "idx_escalations_user_pending", table_name="escalations", schema="eidan"
    )
    op.drop_table("escalations", schema="eidan")
