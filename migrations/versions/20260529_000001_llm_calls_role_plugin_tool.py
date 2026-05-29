# SPDX-License-Identifier: AGPL-3.0-or-later
"""extend llm_calls_role_chk with plugin_tool

Revision ID: 20260529000001
Revises: 20260523000001
Create Date: 2026-05-29

Issue #16 lands the plugin-emitted write path on ``eidan.llm_calls``
(``docs/010 §3.1`` row 5). A plugin tool that invokes an LLM (or
shells out to a vendor CLI, or hits a paid API directly) calls
``await ctx.report_llm_call(...)`` to land a row through the host
so per-turn / per-conversation / per-day caps (``docs/010 §4``)
and the PRO analytics dashboards (``§7``) aggregate the spend
uniformly with in-loop spend. The new row carries the same four
token axes and the same ``cost_usd`` semantics as any in-loop row;
only its origin (a plugin tool handler, not the in-process
Provider abstraction) differs.

The host writer accepts a caller-supplied ``role`` so a plugin can
attribute the spend to its purpose. The existing closed set
(``primary``, ``critic``, the four classifiers, ``subagent``, ...)
already covers everything the core loop emits; ``plugin_tool`` is
the new default role for the plugin-writer path. A plugin that's
specifically wrapping a summarisation pass or an embedding upstream
SHOULD use ``summariser`` / ``embed`` instead so the analytics
plugin's role-faceted dashboards group it correctly.

Additive only — existing rows are unaffected.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260529000001"
down_revision: str | None = "20260523000001"
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
                'plugin_tool',
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
