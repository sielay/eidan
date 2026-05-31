# SPDX-License-Identifier: AGPL-3.0-or-later
"""add eidan.node_heartbeats.plugins JSONB column

Revision ID: 20260531000001
Revises: 20260529000001
Create Date: 2026-05-31

Issue #52 — the admin nodes pane shows ``node_id`` / ``node_type`` /
``last_seen`` but not what plugins each node has loaded. Plugin
discovery is per-process (``EIDAN_PLUGINS_DIR`` + the
``EIDAN_DISABLED_PLUGINS`` env filter), so two backend instances on
the same Postgres can carry different sets — runtime plugin installs
on the Pi don't propagate to Fly machines until they restart with a
fresh ``plugins/`` directory.

Storage shape: a single JSONB column on ``node_heartbeats``, written
inside the same UPSERT the heartbeat loop already runs every 30s.
The set is overwhelmingly static for a given process (plugins are
loaded once at bootstrap and don't churn), so a sibling table keyed
by ``node_id`` would be all overhead for no read-side win. The
existing ``GET /api/admin/nodes`` query returns it inline alongside
``metadata`` with no join.

Default ``'[]'`` so existing rows from prior boots stay valid before
the first new heartbeat lands. Once the upgraded code runs the next
heartbeat the column is rewritten with the live plugin list.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260531000001"
down_revision: str | None = "20260529000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "node_heartbeats",
        sa.Column(
            "plugins",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        schema="eidan",
    )


def downgrade() -> None:
    op.drop_column("node_heartbeats", "plugins", schema="eidan")
