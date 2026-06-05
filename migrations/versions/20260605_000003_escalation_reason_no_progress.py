# SPDX-License-Identifier: AGPL-3.0-or-later
"""widen escalations_reason_chk with 'no_progress'

Revision ID: 20260605000003
Revises: 20260605000002
Create Date: 2026-06-05

Issue #186 (``docs/027 §7``) — a governed autonomous loop that bails on
the no-progress detector (repeated intent / idle) escalates with reason
``no_progress``. Widen the closed-set CHECK on ``eidan.escalations`` to
admit it. Additive: no existing row uses the new value, so the
drop-and-recreate validates instantly.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260605000003"
down_revision: str | None = "20260605000002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_REASONS_WITH = (
    "'missing_input','permission_denied','external_failure',"
    "'ambiguous_intent','over_budget','over_capacity','no_progress',"
    "'unrecoverable_error','other'"
)
_REASONS_WITHOUT = (
    "'missing_input','permission_denied','external_failure',"
    "'ambiguous_intent','over_budget','over_capacity',"
    "'unrecoverable_error','other'"
)


def upgrade() -> None:
    op.execute(
        "ALTER TABLE eidan.escalations DROP CONSTRAINT escalations_reason_chk"
    )
    op.execute(
        f"ALTER TABLE eidan.escalations ADD CONSTRAINT escalations_reason_chk "
        f"CHECK (reason_class IN ({_REASONS_WITH}))"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE eidan.escalations DROP CONSTRAINT escalations_reason_chk"
    )
    op.execute(
        f"ALTER TABLE eidan.escalations ADD CONSTRAINT escalations_reason_chk "
        f"CHECK (reason_class IN ({_REASONS_WITHOUT}))"
    )
