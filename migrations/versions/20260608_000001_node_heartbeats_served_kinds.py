# SPDX-License-Identifier: AGPL-3.0-or-later
"""add eidan.node_heartbeats.served_kinds JSONB column

Revision ID: 20260608000001
Revises: 20260607000003
Create Date: 2026-06-08

Issue #249 — the universal delegation queue (``eidan.jobs``, #247/#248)
routes work by capability **kind**; a node serving that kind with spare
capacity claims a job and runs it end-to-end. Routing is pull-based, so a
node's served kinds + capacity are implicit today and surfaced nowhere.

This adds the companion to the ``plugins`` advertisement (#52): a single
JSONB column carrying ``[{"kind": ..., "capacity": ...}, ...]`` — what
this node is built to serve — written inside the same UPSERT the
heartbeat loop already runs every 30s. Like ``plugins``, the set is
overwhelmingly static for a given process (capabilities are registered
once at activation), so a sibling table keyed by ``node_id`` would be all
overhead for no read-side win; ``GET /api/admin/nodes`` returns it inline
with no join.

Default ``'[]'`` so existing rows from prior boots stay valid before the
first new heartbeat lands. Additive — zero behavioural change until a
plugin registers a capability via ``ctx.register_capabilities``.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260608000001"
down_revision: str | None = "20260607000003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "node_heartbeats",
        sa.Column(
            "served_kinds",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        schema="eidan",
    )


def downgrade() -> None:
    op.drop_column("node_heartbeats", "served_kinds", schema="eidan")
