# SPDX-License-Identifier: AGPL-3.0-or-later
"""eidan.conversations + messages — host matbot Session (version/status/persona/contexts, seq, trace_id)

Revision ID: 20260610000002
Revises: 20260610000001
Create Date: 2026-06-10

Second half of the matbot data-shape migration (see the matbot-core-pivot decision).
20260610_000001 relaxed messages.role for 'marker' and added messages.content_blocks. This
adds the remaining columns matbot's Session needs on top of the original eidan memory schema
(introspected live against the deployed eidan schema):

conversations:
  - version   bigint  — backs the Store<Session> compare-and-swap.
  - status    text    — Session.status (active|archived|pinned).
  - persona   text    — Session.persona.
  - contexts  jsonb   — Session.contexts (string[]).
  (Session.parentSessionId maps to the EXISTING parent_conversation_id; branchPointMessageId
   to the EXISTING origin_message_id — no new columns for those.)

messages:
  - seq       bigint identity — append order within a conversation. Required because every row
    written in one keen-save transaction shares now() (transaction start time), so created_at
    cannot order the messages of a single turn.
  - trace_id  text            — matbot Message.traceId, the per-turn correlation id.

All additive; the Python backend ignores the new columns. (A follow-up should backfill
content_blocks for pre-existing rows from content/tool_calls/tool_results.)
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260610000002"
down_revision: str | None = "20260610000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE eidan.conversations ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1")
    op.execute("ALTER TABLE eidan.conversations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'")
    op.execute("ALTER TABLE eidan.conversations DROP CONSTRAINT IF EXISTS conversations_status_chk")
    op.execute(
        "ALTER TABLE eidan.conversations ADD CONSTRAINT conversations_status_chk "
        "CHECK (status IN ('active','archived','pinned'))"
    )
    op.execute("ALTER TABLE eidan.conversations ADD COLUMN IF NOT EXISTS persona text")
    op.execute("ALTER TABLE eidan.conversations ADD COLUMN IF NOT EXISTS contexts jsonb NOT NULL DEFAULT '[]'::jsonb")
    op.execute("ALTER TABLE eidan.messages ADD COLUMN IF NOT EXISTS trace_id text")
    op.execute("ALTER TABLE eidan.messages ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY")


def downgrade() -> None:
    op.execute("ALTER TABLE eidan.messages DROP COLUMN IF EXISTS seq")
    op.execute("ALTER TABLE eidan.messages DROP COLUMN IF EXISTS trace_id")
    op.execute("ALTER TABLE eidan.conversations DROP CONSTRAINT IF EXISTS conversations_status_chk")
    op.execute("ALTER TABLE eidan.conversations DROP COLUMN IF EXISTS contexts")
    op.execute("ALTER TABLE eidan.conversations DROP COLUMN IF EXISTS persona")
    op.execute("ALTER TABLE eidan.conversations DROP COLUMN IF EXISTS status")
    op.execute("ALTER TABLE eidan.conversations DROP COLUMN IF EXISTS version")
