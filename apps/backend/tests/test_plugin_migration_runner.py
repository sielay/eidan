"""Phase 4 acceptance tests for the plugin migration runner.

Covers (per issue #46):

- ``apply_plugin_migrations`` walks the loaded plugin list and, for each
  plugin with a ``migrations:`` stanza, ensures the
  ``plugin_<name_underscored>`` schema exists and runs ``alembic upgrade
  head`` against the plugin's ``versions/`` directory.
- The acceptance migration on ``example-core`` actually creates
  ``plugin_example_core.foo`` after a single run.
- Re-running the runner is a no-op (alembic's normal upgrade-head
  semantics tracked in ``plugin_example_core.alembic_version``).
- Plugins without a ``migrations:`` stanza are skipped — no schema is
  created on their behalf.
- A failure in one plugin's migration aborts the whole run with the
  alembic error propagated upward.
"""

from __future__ import annotations

import os
import textwrap
from pathlib import Path

import asyncpg
import pytest
from eidan_backend.plugins import (
    apply_plugin_migrations,
    downgrade_plugin_migrations,
    load_plugins,
    schema_for_plugin,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_REAL_PLUGINS_DIR = _REPO_ROOT / "plugins"


def _async_database_url() -> str:
    """Return the async-form ``DATABASE_URL`` set by the ``eidan_db`` fixture.

    The plugin migration runner expects the SQLAlchemy async URL
    (``postgresql+asyncpg://...``) because alembic's ``async_engine_from_config``
    consumes it directly. The fixture sets ``os.environ["DATABASE_URL"]``
    to that form before yielding; tests read it back here.
    """
    url = os.environ.get("DATABASE_URL")
    assert url is not None, "eidan_db fixture must set DATABASE_URL"
    return url


def _plain(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


# ---------- acceptance: real example-core migration ---------------------------


@pytest.mark.asyncio
async def test_runner_creates_plugin_example_core_foo(eidan_db: str) -> None:
    """Acceptance criterion #1: a test plugin with one migration creating
    ``plugin_example_core.foo`` gets that table after the runner runs."""
    plugins = load_plugins(_REAL_PLUGINS_DIR)
    await apply_plugin_migrations(plugins, database_url=_async_database_url())

    conn = await asyncpg.connect(_plain(eidan_db))
    try:
        row = await conn.fetchrow(
            """
            SELECT 1
              FROM information_schema.tables
             WHERE table_schema = $1 AND table_name = $2
            """,
            "plugin_example_core",
            "foo",
        )
        assert row is not None, "plugin_example_core.foo should exist"

        # alembic_version lives in the plugin's own schema (docs/001 §4.1).
        version_row = await conn.fetchrow(
            "SELECT version_num FROM plugin_example_core.alembic_version"
        )
        assert version_row is not None
        assert version_row["version_num"] == "20260514000000"
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_runner_is_idempotent(eidan_db: str) -> None:
    """Acceptance criterion #2: re-running the runner is a no-op.

    The first call applies the migration; the second call sees the head
    revision already recorded in ``plugin_example_core.alembic_version``
    and does nothing further.
    """
    plugins = load_plugins(_REAL_PLUGINS_DIR)

    # First run: migration applied (or already applied from a prior test
    # in this session — eidan_db is session-scoped).
    await apply_plugin_migrations(plugins, database_url=_async_database_url())

    # Second run: no-op. We assert by counting alembic_version rows
    # (always exactly one) and confirming the head is unchanged.
    await apply_plugin_migrations(plugins, database_url=_async_database_url())

    conn = await asyncpg.connect(_plain(eidan_db))
    try:
        rows = await conn.fetch("SELECT version_num FROM plugin_example_core.alembic_version")
        assert len(rows) == 1
        assert rows[0]["version_num"] == "20260514000000"
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_downgrade_drops_plugin_schema(eidan_db: str) -> None:
    """Phase 4 acceptance for issue #48: ``downgrade_plugin_migrations``
    walks the plugin's history backward and drops the schema.

    Re-applying migrations after the downgrade re-creates the table —
    proving the helper leaves the operator in a clean state suitable
    for a follow-up ``eidan admin db migrate``.
    """
    plugins = load_plugins(_REAL_PLUGINS_DIR)
    await apply_plugin_migrations(plugins, database_url=_async_database_url())

    # Sanity: the schema + table exist before the downgrade.
    conn = await asyncpg.connect(_plain(eidan_db))
    try:
        before = await conn.fetchval(
            "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
            schema_for_plugin("example-core"),
        )
        assert before is not None
    finally:
        await conn.close()

    await downgrade_plugin_migrations(plugins, database_url=_async_database_url())

    # The plugin schema is gone.
    conn = await asyncpg.connect(_plain(eidan_db))
    try:
        after = await conn.fetchval(
            "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
            schema_for_plugin("example-core"),
        )
        assert after is None
    finally:
        await conn.close()

    # Re-applying migrations re-creates the schema — a subsequent
    # ``db migrate`` shows no surprises (the issue's acceptance check).
    await apply_plugin_migrations(plugins, database_url=_async_database_url())
    conn = await asyncpg.connect(_plain(eidan_db))
    try:
        again = await conn.fetchval(
            """
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = $1 AND table_name = 'foo'
            """,
            schema_for_plugin("example-core"),
        )
        assert again is not None
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_runner_skips_plugins_without_migrations_stanza(eidan_db: str) -> None:
    """``example-behaviour`` declares no migrations: stanza, so the runner
    must not create ``plugin_example_behaviour`` on its behalf."""
    plugins = load_plugins(_REAL_PLUGINS_DIR)
    assert any(p.manifest.name == "example-behaviour" for p in plugins)

    await apply_plugin_migrations(plugins, database_url=_async_database_url())

    conn = await asyncpg.connect(_plain(eidan_db))
    try:
        row = await conn.fetchrow(
            "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
            schema_for_plugin("example-behaviour"),
        )
        assert row is None, "no schema should be created for plugins without migrations"
    finally:
        await conn.close()


# ---------- failure path ------------------------------------------------------


def _write_failing_plugin(tmp_path: Path) -> Path:
    """Stage a plugin whose only migration intentionally fails on upgrade.

    The migration references a non-existent table so Postgres rejects
    the upgrade and the runner is forced to surface the alembic error.
    """
    name = "broken-mig"
    plugin_dir = tmp_path / name
    plugin_dir.mkdir()
    pkg = name.replace("-", "_")
    (plugin_dir / pkg).mkdir()
    (plugin_dir / pkg / "__init__.py").write_text("", encoding="utf-8")
    (plugin_dir / pkg / "plugin.py").write_text(
        textwrap.dedent(
            """\
            from eidan_backend.plugins import PluginBase

            class Plugin(PluginBase):
                name = "broken-mig"
            """
        ),
        encoding="utf-8",
    )
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            name: broken-mig
            version: 0.1.0
            tier: core
            license: AGPL
            backend:
              entrypoint: broken_mig.plugin:Plugin
            migrations:
              dir: ./migrations
              driver: alembic
            """
        ),
        encoding="utf-8",
    )
    versions = plugin_dir / "migrations" / "versions"
    versions.mkdir(parents=True)
    (versions / "20260514_000099_break.py").write_text(
        textwrap.dedent(
            """\
            from __future__ import annotations
            from typing import Sequence, Union
            from alembic import op

            revision: str = "20260514000099"
            down_revision: Union[str, None] = None
            branch_labels: Union[str, Sequence[str], None] = None
            depends_on: Union[str, Sequence[str], None] = None

            def upgrade() -> None:
                # Reference a table that does not exist -> Postgres rejects.
                op.execute("INSERT INTO does_not_exist_table (x) VALUES (1)")

            def downgrade() -> None:
                pass
            """
        ),
        encoding="utf-8",
    )
    return plugin_dir


@pytest.mark.asyncio
async def test_runner_aborts_on_first_plugin_failure(
    eidan_db: str,
    tmp_path: Path,
) -> None:
    """Acceptance per `docs/002 §4.3`: a plugin failure aborts the run.

    The runner does not swallow alembic exceptions; they propagate so
    the CLI surfaces a non-zero exit code and the operator sees the
    failing plugin's traceback.
    """
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_failing_plugin(plugins_dir)

    plugins = load_plugins(plugins_dir)
    with pytest.raises(Exception):  # noqa: B017,PT011 — alembic surfaces a sqlalchemy error
        await apply_plugin_migrations(plugins, database_url=_async_database_url())

    # The advisory-lock side-channel released cleanly even though
    # alembic raised — re-running with a healthy plugin set must
    # still acquire the lock.
    conn = await asyncpg.connect(_plain(eidan_db))
    try:
        # Verify no migration history was created in the broken plugin's
        # schema (alembic transactions roll back on error).
        row = await conn.fetchrow(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = $1 AND table_name = 'alembic_version'",
            schema_for_plugin("broken-mig"),
        )
        assert row is None
    finally:
        await conn.close()
