"""extend llm_calls_role_chk with scope_classifier + sizer

Revision ID: 20260514000003
Revises: 20260514000002
Create Date: 2026-05-14

Phase 1.5 adds two upstream provider calls before the primary call
(`docs/005 §3` steps ③–④). Each writes its own `llm_calls` row, so
the role check constraint from `init_memory_model` needs to accept the
new role values.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260514000003"
down_revision: str | None = "20260514000002"
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
                'subagent',
                'summariser',
                'tool_synthesis',
                'embed',
                'other'
            )
        )
        """
    )
