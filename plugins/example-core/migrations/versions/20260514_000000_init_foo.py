"""init_foo — example-core's plugin-private smoke table

Revision ID: 20260514000000
Revises:
Create Date: 2026-05-14

Phase 4 acceptance for the plugin migration runner: this migration
creates a single ``foo`` table inside the ``plugin_example_core``
schema. The runner is responsible for ensuring the schema exists
(`docs/001 §4.1`); the migration just creates the table inside it.

There is no real product surface here — example-core is the test
plugin pinned in `docs/001 §1.1` and exists so the host's loader,
lifecycle runner, and migration runner all have something to drive
against.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260514000000"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE plugin_example_core.foo (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            label       text        NOT NULL,
            created_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS plugin_example_core.foo")
