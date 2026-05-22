"""plugin_state — installed-plugin registry

Revision ID: 20260514000006
Revises: 20260514000005
Create Date: 2026-05-14

The host walks ``plugins/<name>/`` on start, validates each manifest,
and runs the lifecycle hooks pinned in ``docs/001 §8``. ``on_install``
is a one-shot — it fires the first time the host sees a given plugin
``name`` and is skipped on every subsequent start.

To answer "have I installed this plugin before?" without re-doing the
work, the loader needs a small piece of persistent state. This table
is the source of truth: one row per ``(name)``, carrying the version
that was last successfully installed. ``on_install`` runs when no row
exists; the lifecycle runner inserts the row on success.

Schema upgrades (per-plugin ``on_upgrade``, ``docs/001 §8.5``) are
out of scope for Phase 4 — the column is in place for the upgrade
path to use later.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260514000006"
down_revision: str | None = "20260514000005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE eidan.plugin_state (
            name            text        PRIMARY KEY,
            version         text        NOT NULL,
            installed_at    timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT plugin_state_name_chk CHECK (
                name ~ '^[a-z0-9][a-z0-9-]*$'
            )
        )
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_plugin_state_updated_at
        BEFORE UPDATE ON eidan.plugin_state
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS eidan.plugin_state")
