"""extend llm_calls_role_chk with critic

Revision ID: 20260514000004
Revises: 20260514000003
Create Date: 2026-05-14

Phase 1.5 wires the conditional critic call (`docs/005 §3 ⑧` /
`§5.8`). The critic emits one `llm_calls` row per intervention with
`role = 'critic'`, so the role check constraint needs to accept it.
Additive only — existing rows are unaffected.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260514000004"
down_revision: str | None = "20260514000003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE eidan.llm_calls DROP CONSTRAINT llm_calls_role_chk")
    op.execute(
        """
        ALTER TABLE eidan.llm_calls
        ADD CONSTRAINT llm_calls_role_chk CHECK (
            role IN (
                'primary',
                'scope_classifier',
                'sizer',
                'critic',
                'subagent',
                'summariser',
                'tool_synthesis',
                'embed',
                'other'
            )
        )
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE eidan.llm_calls DROP CONSTRAINT llm_calls_role_chk")
    op.execute(
        """
        ALTER TABLE eidan.llm_calls
        ADD CONSTRAINT llm_calls_role_chk CHECK (
            role IN (
                'primary',
                'scope_classifier',
                'sizer',
                'subagent',
                'summariser',
                'tool_synthesis',
                'embed',
                'other'
            )
        )
        """
    )
