# SPDX-License-Identifier: AGPL-3.0-or-later
"""add eidan.conversations parent linkage (sub-conversations)

Revision ID: 20260605000001
Revises: 20260531000001
Create Date: 2026-06-05

Issue #185 — conversations gain a parent linkage so long-running or
fanned-out sub-work gets its own child conversation instead of
flooding the originating thread. Two nullable FKs, both additive
(every existing row stays valid as a root conversation):

- ``parent_conversation_id`` -> ``eidan.conversations(id)``
  ``ON DELETE SET NULL``: the conversation this one stems from.
  ``NULL`` = a root conversation (the existing shape).
- ``origin_message_id`` -> ``eidan.messages(id)`` ``ON DELETE SET
  NULL``: the specific message in the parent that spawned this child,
  so a UI can anchor the child under the right turn.

This is a tree OF conversations, navigable but not inlined — NOT a
message fork (messages are already tree-shaped via
``parent_message_id`` within a single conversation, ``003 §3``).

Partial index on ``parent_conversation_id WHERE deleted_at IS NULL``
serves the read path "list the children of conversation X" per the
soft-delete convention (``003 §1.3``).
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260605000001"
down_revision: str | None = "20260531000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE eidan.conversations
            ADD COLUMN parent_conversation_id uuid
                REFERENCES eidan.conversations(id) ON DELETE SET NULL,
            ADD COLUMN origin_message_id uuid
                REFERENCES eidan.messages(id) ON DELETE SET NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_conversations_parent
            ON eidan.conversations (parent_conversation_id, created_at DESC)
            WHERE parent_conversation_id IS NOT NULL
              AND deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_conversations_origin_message
            ON eidan.conversations (origin_message_id)
            WHERE origin_message_id IS NOT NULL
              AND deleted_at IS NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS eidan.idx_conversations_origin_message")
    op.execute("DROP INDEX IF EXISTS eidan.idx_conversations_parent")
    op.execute(
        """
        ALTER TABLE eidan.conversations
            DROP COLUMN IF EXISTS origin_message_id,
            DROP COLUMN IF EXISTS parent_conversation_id
        """
    )
