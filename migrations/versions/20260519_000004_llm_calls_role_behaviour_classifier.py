"""extend llm_calls_role_chk with behaviour_classifier

Revision ID: 20260519000004
Revises: 20260519000003
Create Date: 2026-05-19

Phase 1 lands the LLM call from docs/006 §5 (the behaviour classifier
that picks intent: triggers per turn). Each call writes one
llm_calls row with role='behaviour_classifier'; the check constraint
gains the new value.

Additive only — existing rows are unaffected.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260519000004"
down_revision: str | None = "20260519000003"
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
                'behaviour_classifier',
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
