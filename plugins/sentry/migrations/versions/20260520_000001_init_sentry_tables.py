"""init sentry tick + nudge tables

Revision ID: sentry20260520000001
Revises:
Create Date: 2026-05-20

Phase 1 implementation of docs/SENTRY_FEATURE_SPEC.md §"Data
Model". Two tables in the ``plugin_sentry`` schema:

- ``sentry_ticks``  — one row per tick per user, capturing what
  patterns the deterministic detectors saw.
- ``sentry_nudges`` — one row per detected pattern, the
  operator-facing artefact. Unique on (user_id, pattern_name, day)
  so re-emitting on the same day is a no-op.

The ``sentry_escalations`` table from the spec is deferred — Phase 1
re-uses the host-side ``eidan.escalations`` envelope for surfacing
patterns to the operator inbox, which already has the lifecycle
(pending → acknowledged → resolved) the spec calls for.

The plugin runner creates the ``plugin_sentry`` schema before this
migration runs (`docs/001 §4.1`).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "sentry20260520000001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE plugin_sentry.sentry_ticks (
            id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            tick_id              text        NOT NULL,
            user_id              uuid        NOT NULL,
            started_at           timestamptz NOT NULL,
            completed_at         timestamptz NOT NULL,
            pattern_names        text[]      NOT NULL DEFAULT '{}',
            escalations_queued   integer     NOT NULL DEFAULT 0,
            UNIQUE (tick_id, user_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_sentry_ticks_user_started
          ON plugin_sentry.sentry_ticks (user_id, started_at DESC)
        """
    )

    op.execute(
        """
        CREATE TABLE plugin_sentry.sentry_nudges (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid        NOT NULL,
            pattern_name    text        NOT NULL,
            day             date        NOT NULL,
            severity        text        NOT NULL,
            summary         text        NOT NULL,
            evidence        jsonb       NOT NULL DEFAULT '[]'::jsonb,
            metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
            sent_at         timestamptz,
            dismissed_at    timestamptz,
            created_at      timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT sentry_nudges_severity_chk CHECK (
                severity IN ('low', 'medium', 'high')
            ),
            CONSTRAINT sentry_nudges_unique_per_day UNIQUE (
                user_id, pattern_name, day
            )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_sentry_nudges_user_undismissed
          ON plugin_sentry.sentry_nudges (user_id, created_at DESC)
          WHERE dismissed_at IS NULL
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS plugin_sentry.idx_sentry_nudges_user_undismissed"
    )
    op.execute("DROP TABLE IF EXISTS plugin_sentry.sentry_nudges")
    op.execute(
        "DROP INDEX IF EXISTS plugin_sentry.idx_sentry_ticks_user_started"
    )
    op.execute("DROP TABLE IF EXISTS plugin_sentry.sentry_ticks")
