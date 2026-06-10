# SPDX-License-Identifier: AGPL-3.0-or-later
"""eidan.messages — allow 'marker' role + add content_blocks for the matbot runtime

Revision ID: 20260610000001
Revises: 20260609000001
Create Date: 2026-06-10

The two data-shape deltas surfaced by the matbot data-shape spike (see the
``matbot-core-pivot`` decision). eidan's core is being rebuilt as plugins on the
matbot runtime; the relational memory in ``eidan.*`` becomes a matbot
``StorageBackend`` (``@eidan/storage-postgres``). matbot's message model is richer
than the original ``messages`` row, so:

1. **'marker' role.** matbot carries opaque, LLM-invisible annotations as messages
   with the dedicated ``marker`` role (links, cross-references, status). The
   ``messages_role_chk`` constraint must admit it.

2. **content_blocks.** matbot ``Message.content`` is an ordered array of typed
   blocks (text, thinking, tool-call/result, image, document, marker, …). We store
   that array verbatim in ``content_blocks`` jsonb so a message round-trips
   losslessly; the existing ``content`` / ``tool_calls`` / ``tool_results`` columns
   become denormalised projections kept for queryability.

Additive and backwards-compatible: the Python backend ignores ``content_blocks``;
the matbot backend treats it as the source of truth for a message's content.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260610000001"
down_revision: str | None = "20260609000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE eidan.messages DROP CONSTRAINT IF EXISTS messages_role_chk")
    op.execute(
        """
        ALTER TABLE eidan.messages
            ADD CONSTRAINT messages_role_chk
            CHECK (role IN ('user', 'assistant', 'system', 'tool', 'marker'))
        """
    )
    op.execute(
        """
        ALTER TABLE eidan.messages
            ADD COLUMN IF NOT EXISTS content_blocks jsonb NOT NULL DEFAULT '[]'::jsonb
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE eidan.messages DROP COLUMN IF EXISTS content_blocks")
    op.execute("ALTER TABLE eidan.messages DROP CONSTRAINT IF EXISTS messages_role_chk")
    # Restore the original (marker-less) constraint.
    op.execute(
        """
        ALTER TABLE eidan.messages
            ADD CONSTRAINT messages_role_chk
            CHECK (role IN ('user', 'assistant', 'system', 'tool'))
        """
    )
