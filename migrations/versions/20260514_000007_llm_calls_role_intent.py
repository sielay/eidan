"""extend llm_calls_role_chk with intent_classifier

Revision ID: 20260514000007
Revises: 20260514000006
Create Date: 2026-05-14

Issue #59 — adds the intent classifier as step ④.5 of the loop
(`docs/005 §3`). Each intent-classifier call emits one ``llm_calls``
row with ``role = 'intent_classifier'``, so the role check constraint
needs to accept it. Additive only — existing rows are unaffected.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260514000007"
down_revision: str | None = "20260514000006"
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
                'intent_classifier',
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
