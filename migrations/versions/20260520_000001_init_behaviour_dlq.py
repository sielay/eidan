"""init eidan.behaviour_dlq table

Revision ID: 20260520000001
Revises: 20260519000004
Create Date: 2026-05-20

Phase 1 implementation of `docs/001 §5.3` dead-letter table — the
"permanent failures land in a dead-letter table the admin UI
surfaces" line. Before this migration the dispatcher swallowed
handler exceptions silently to keep the scheduler alive; now each
swallowed exception writes one row here so the operator can read
"why did cron stop firing my behaviour" without scraping logs.

The table is intentionally narrow: behaviour id, trigger kind, the
key that would have de-duped a retry, the exception type and
message, and a JSONB metadata bag for whatever else the dispatcher
chooses to attach (slot string, host instance id, etc). It is *not*
an escalation: failed dispatches are common (e.g. a transient DB
hiccup); only the operator's read of the table decides whether one
warrants attention.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260520000001"
down_revision: str | None = "20260519000004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "behaviour_dlq",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # The behaviour that failed, e.g. ``sentry:tick`` or
        # ``plugin_calendar:sync``. Not FK'd because behaviours live
        # in-process registries, not in a table.
        sa.Column("behaviour_id", sa.Text(), nullable=False),
        # The trigger kind that fired (``cron`` / ``schedule`` /
        # ``event`` / ``webhook``). Lets the operator filter on
        # "every scheduled job that died today".
        sa.Column("trigger_kind", sa.Text(), nullable=False),
        # The idempotency key the dispatcher derived for the firing.
        # Useful for cross-referencing with ``llm_calls`` and
        # ``messages`` rows that share the key.
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        # Python exception class name (no module — Class.__name__).
        sa.Column("error_class", sa.Text(), nullable=False),
        # ``str(exc)``; trimmed by the writer to a sane upper bound.
        sa.Column("error_message", sa.Text(), nullable=False),
        # Free-form context: slot string, instance id, retry count
        # once retries land.
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
        # Operator-driven status. ``pending`` rows are unread;
        # ``acknowledged`` rows the operator has seen and chosen not
        # to act on; ``resolved`` rows the operator has acted on.
        # The admin UI moves rows through these states.
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.CheckConstraint(
            "status IN ('pending','acknowledged','resolved')",
            name="behaviour_dlq_status_chk",
        ),
        sa.CheckConstraint(
            "trigger_kind IN ('cron','schedule','event','webhook','intent','agent')",
            name="behaviour_dlq_trigger_kind_chk",
        ),
        schema="eidan",
    )

    # The dominant read shape: "show me the recent pending failures,
    # newest first". Partial index keeps it cheap as the table grows.
    op.create_index(
        "idx_behaviour_dlq_pending",
        "behaviour_dlq",
        [sa.text("created_at DESC")],
        schema="eidan",
        postgresql_where=sa.text("status = 'pending'"),
    )

    # Secondary read shape: "show me every failure for this behaviour
    # in the last 24h". The unique-ish nature of ``behaviour_id`` plus
    # ``created_at DESC`` covers the dashboard view.
    op.create_index(
        "idx_behaviour_dlq_by_behaviour",
        "behaviour_dlq",
        ["behaviour_id", sa.text("created_at DESC")],
        schema="eidan",
    )


def downgrade() -> None:
    op.drop_index(
        "idx_behaviour_dlq_by_behaviour",
        table_name="behaviour_dlq",
        schema="eidan",
    )
    op.drop_index(
        "idx_behaviour_dlq_pending",
        table_name="behaviour_dlq",
        schema="eidan",
    )
    op.drop_table("behaviour_dlq", schema="eidan")
