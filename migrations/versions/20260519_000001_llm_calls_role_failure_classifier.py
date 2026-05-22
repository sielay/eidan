"""extend llm_calls_role_chk with failure_classifier

Revision ID: 20260519000001
Revises: 20260514000007
Create Date: 2026-05-19

Phase 1 lands the classifier-fallback path from docs/009 §6. When the
sum of pre-primary cross-turn signals crosses the failure threshold,
the loop spends one extra LLM call on a small classifier whose only
job is to confirm or veto the deterministic verdict. That call lands
in `eidan.llm_calls` with `role = 'failure_classifier'`, so the role
check constraint needs the new value.

Additive only — existing rows are unaffected.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260519000001"
down_revision: str | None = "20260514000007"
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
                'failure_classifier',
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
