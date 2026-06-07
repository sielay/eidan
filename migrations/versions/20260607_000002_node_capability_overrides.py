# SPDX-License-Identifier: AGPL-3.0-or-later
"""runtime per-node capability overrides — DB-driven enable/disable

Revision ID: 20260607000002
Revises: 20260607000001
Create Date: 2026-06-07

Issue #243 (P1 of #201). A node's capabilities are configured at
deploy-time via the topology ``disable: [...]`` list; this adds a
**runtime** override so a capability can be toggled live — without a
redeploy — from a SQL flip, a CLI, or the node-graph UI.

Shape: ``(node_id, capability)`` → ``enabled``. **Absence of a row means
enabled** (a pure opt-out: nothing changes until an operator inserts a
disabling row), so this is additive with zero behavioural change until
used. The first consumer is the sage bundle's work-claimers
(``git:poll`` / ``sage:pr_iteration``) gating on ``capability='work'``,
so the operator can park a node from claiming while its monitoring and
chat keep running.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260607000002"
down_revision: str | None = "20260607000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE eidan.node_capability_overrides (
            node_id    text        NOT NULL,
            capability text        NOT NULL,
            enabled    boolean     NOT NULL DEFAULT true,
            updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (node_id, capability)
        )
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_node_capability_overrides_updated_at
        BEFORE UPDATE ON eidan.node_capability_overrides
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP TABLE IF EXISTS eidan.node_capability_overrides"
    )
