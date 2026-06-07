# SPDX-License-Identifier: AGPL-3.0-or-later
"""eidan.jobs — the universal, surface-agnostic delegation work-queue

Revision ID: 20260607000003
Revises: 20260607000002
Create Date: 2026-06-07

Issue #247. The source of truth for *delegated work* — across surfaces
(web / slack / telegram / agent) and bundles (code via sage, business
via charles, …). A `delegate` writes a job targeting a **capability
class** (`kind`), not a specific node. Any node that serves that kind and
has spare capacity atomically claims it by `node_id`
(`FOR UPDATE SKIP LOCKED`) and owns it end-to-end. GitHub is just where a
*code* worker pushes its output (PR) — an adapter detail, not the queue.

State machine: ``queued → claimed → running → done | failed | cancelled``.
A node reaps its own stale `claimed`/`running` rows back to `queued` on a
heartbeat (handled in worker code, not here).
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260607000003"
down_revision: str | None = "20260607000002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE eidan.jobs (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            -- the capability CLASS this job needs (which kind of worker),
            -- e.g. 'code' | 'business'. Routing is by kind, never by node.
            kind        text        NOT NULL,
            -- human-readable task; the worker's prompt / brief.
            goal        text        NOT NULL,
            -- structured params the worker needs (repo, stack, bundle, …).
            payload     jsonb       NOT NULL DEFAULT '{}',
            -- where the delegation originated: 'web'|'slack'|'telegram'|'agent'|…
            surface     text,
            -- who delegated it (nullable: a system/cron delegation has no user).
            user_id     uuid        REFERENCES eidan.users(id) ON DELETE SET NULL,
            status      text        NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','claimed','running','done','failed','cancelled')),
            -- the node that claimed it (core node_identity id). NULL until claimed.
            claimed_by  text,
            claimed_at  timestamptz,
            -- worker output (e.g. {"pr_url": "..."}) and failure detail.
            result      jsonb,
            error       text,
            created_at  timestamptz NOT NULL DEFAULT now(),
            updated_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    # Claimable lookup: queued jobs by kind, oldest first (the worker's
    # `... WHERE status='queued' AND kind = ANY($kinds) ORDER BY created_at
    # FOR UPDATE SKIP LOCKED` claim path).
    op.execute(
        """
        CREATE INDEX jobs_queued_kind_idx
            ON eidan.jobs (kind, created_at)
            WHERE status = 'queued'
        """
    )
    # A node's in-flight set (for capacity checks + stale reaping).
    op.execute(
        """
        CREATE INDEX jobs_inflight_node_idx
            ON eidan.jobs (claimed_by, claimed_at)
            WHERE status IN ('claimed','running')
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_jobs_updated_at
        BEFORE UPDATE ON eidan.jobs
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS eidan.jobs")
