# SPDX-License-Identifier: AGPL-3.0-or-later
"""add eidan.users.kind (human | agent | system) — model-C service accounts

Revision ID: 20260605000002
Revises: 20260605000001
Create Date: 2026-06-05

Issue #187 (``docs/028 §3``) — distinguish a human operator from a
non-human principal: an autonomous agent acting on its own behalf
(``agent``), or a host / maintenance actor (``system``). Model C: such
an agent gets a synthetic ``eidan.users`` row flagged here, so
``on_behalf_of`` stays a ``users`` id and RLS / cost accounting / FKs
are all unchanged.

Additive: existing rows default ``'human'``, so nothing else moves.
The named CHECK keeps it a closed set; the auth surface treats
``kind <> 'human'`` as non-loginable (``docs/028 §8``) — service
accounts are provisioned host-side, never via JWT.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260605000002"
down_revision: str | None = "20260605000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE eidan.users
            ADD COLUMN kind text NOT NULL DEFAULT 'human'
                CONSTRAINT users_kind_chk
                CHECK (kind IN ('human', 'agent', 'system'))
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE eidan.users DROP COLUMN IF EXISTS kind")
