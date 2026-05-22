"""Plugin migration runner — `docs/001 §4`, `docs/002 §4`.

Walks every installed plugin in topological order over ``depends_on``
(the order :func:`load_plugins` returns) and, for each plugin whose
manifest declares a ``migrations:`` stanza:

1. Acquires a Postgres advisory lock keyed on
   ``('eidan_migrate', plugin_name)`` so two backend instances racing
   ``eidan admin db migrate`` cannot both upgrade the same plugin
   history at once.
2. Ensures the plugin's private ``plugin_<name_underscored>`` schema
   exists (the env script also issues ``CREATE SCHEMA IF NOT EXISTS``
   inside its transaction; the runner does it up-front so the
   advisory-lock window covers schema creation too).
3. Runs ``alembic upgrade head`` against the plugin's ``versions/``
   directory, with ``alembic_version`` pinned to the plugin's own
   schema so each plugin owns an independent migration history
   (`docs/001 §4.1`, `docs/002 §4.2`).

Aborts the whole run on the first plugin failure (`docs/002 §4.3`);
operators are expected to fix forward.

Driven from :func:`eidan_cli.admin.db_migrate` after core's
``alembic upgrade head`` lands. The host-schema migration extension
point (`docs/018 §6`) is intentionally NOT implemented here — only
the per-plugin private-schema path.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import asyncpg

from .loader import LoadedPlugin, load_plugins

_HOST_ALEMBIC_DIR = Path(__file__).resolve().parent / "_alembic"
"""The host-shipped alembic env that every plugin migration run uses.

Plugin authors do not write their own ``env.py``; they ship only
``versions/<UTC>_<slug>.py`` files (`docs/001 §4.1`). The runner
points Alembic at this directory via ``script_location`` and overrides
``version_locations`` per-plugin so the env can stay generic.
"""


def schema_for_plugin(name: str) -> str:
    """Return the Postgres schema name for ``name`` per `docs/001 §1.2`.

    Hyphens become underscores so ``example-core`` lives in
    ``plugin_example_core``. The naming is part of the plugin contract;
    keeping it in one helper means the runner, the env, and any future
    drop-schema path all agree on the same string.
    """
    return "plugin_" + name.replace("-", "_")


def _to_plain_url(url: str) -> str:
    """Strip the asyncpg dialect prefix asyncpg.connect cannot parse.

    The CLI / operator sets ``DATABASE_URL`` to the SQLAlchemy form
    (``postgresql+asyncpg://...``) so Alembic's async engine can use
    it directly. asyncpg.connect wants the bare ``postgresql://``
    form, so we strip the dialect prefix only for the side-channel
    advisory-lock connection.
    """
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


def _alembic_upgrade_head_sync(
    *,
    versions_dir: Path,
    database_url: str,
    schema: str,
    name: str,
) -> None:
    """Run ``alembic upgrade head`` against one plugin in-process.

    Builds an Alembic :class:`Config` programmatically — no
    plugin-shipped ``alembic.ini`` is required. ``cfg.attributes``
    carries the per-plugin parameters the host-shipped
    ``_alembic/env.py`` reads. Wrapped in a thread by the async caller
    so the alembic command (which spins its own event loop in env.py)
    does not collide with the runner's outer loop.
    """
    from alembic import command
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", str(_HOST_ALEMBIC_DIR))
    # path_separator=os silences a 1.15+ deprecation warning that
    # otherwise nudges every plugin run to add an alembic.ini entry —
    # we don't ship one, so set it on the in-process Config instead.
    cfg.set_main_option("path_separator", "os")
    cfg.set_main_option("version_locations", str(versions_dir))
    cfg.attributes["plugin_name"] = name
    cfg.attributes["plugin_schema"] = schema
    cfg.attributes["database_url"] = database_url
    command.upgrade(cfg, "head")


def _alembic_downgrade_base_sync(
    *,
    versions_dir: Path,
    database_url: str,
    schema: str,
    name: str,
) -> None:
    """Run ``alembic downgrade base`` against one plugin in-process.

    Mirror of :func:`_alembic_upgrade_head_sync` for the uninstall
    path (`docs/001 §8`). The host's shared ``_alembic/env.py`` reads
    the per-plugin parameters from ``cfg.attributes`` and points
    alembic at the plugin's ``versions/`` directory; alembic walks the
    plugin's history in reverse, running each migration's
    ``downgrade()``. Wrapped in a thread by the async caller for the
    same reason the upgrade path is.
    """
    from alembic import command
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", str(_HOST_ALEMBIC_DIR))
    cfg.set_main_option("path_separator", "os")
    cfg.set_main_option("version_locations", str(versions_dir))
    cfg.attributes["plugin_name"] = name
    cfg.attributes["plugin_schema"] = schema
    cfg.attributes["database_url"] = database_url
    command.downgrade(cfg, "base")


async def _apply_one(loaded: LoadedPlugin, database_url: str) -> None:
    """Lock, ensure schema, then run the plugin's alembic upgrade head.

    The advisory lock is held on a dedicated asyncpg connection for
    the full run — schema creation included — so concurrent backend
    instances serialise cleanly. ``pg_advisory_unlock`` runs in a
    ``finally`` so an alembic failure still releases the lock.
    """
    if loaded.manifest.migrations is None:
        return

    name = loaded.manifest.name
    schema = schema_for_plugin(name)
    versions_dir = (
        loaded.plugin_dir / loaded.manifest.migrations.dir / "versions"
    ).resolve()

    conn = await asyncpg.connect(_to_plain_url(database_url))
    try:
        await conn.execute(
            "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
            "eidan_migrate",
            name,
        )
        try:
            await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
            await asyncio.to_thread(
                _alembic_upgrade_head_sync,
                versions_dir=versions_dir,
                database_url=database_url,
                schema=schema,
                name=name,
            )
        finally:
            await conn.execute(
                "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
                "eidan_migrate",
                name,
            )
    finally:
        await conn.close()


async def _downgrade_one(loaded: LoadedPlugin, database_url: str) -> None:
    """Lock, run ``alembic downgrade base``, then drop the plugin schema.

    Mirror of :func:`_apply_one` for the operator uninstall path
    (`docs/001 §8.4`). The same advisory lock keys serialise concurrent
    runs so a parallel ``db migrate`` does not race with an uninstall.
    The schema drop is ``CASCADE`` because alembic's downgrade has
    already walked every migration's ``downgrade()``; anything still
    in the schema is either ``alembic_version`` or operator data the
    plugin should not have written. Phase 4 errs on the side of
    leaving the operator with a clean slate.
    """
    if loaded.manifest.migrations is None:
        return

    name = loaded.manifest.name
    schema = schema_for_plugin(name)
    versions_dir = (
        loaded.plugin_dir / loaded.manifest.migrations.dir / "versions"
    ).resolve()

    conn = await asyncpg.connect(_to_plain_url(database_url))
    try:
        await conn.execute(
            "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
            "eidan_migrate",
            name,
        )
        try:
            schema_exists = await conn.fetchval(
                "SELECT 1 FROM information_schema.schemata "
                "WHERE schema_name = $1",
                schema,
            )
            if schema_exists:
                await asyncio.to_thread(
                    _alembic_downgrade_base_sync,
                    versions_dir=versions_dir,
                    database_url=database_url,
                    schema=schema,
                    name=name,
                )
                await conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        finally:
            await conn.execute(
                "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
                "eidan_migrate",
                name,
            )
    finally:
        await conn.close()


async def apply_plugin_migrations(
    plugins: list[LoadedPlugin],
    *,
    database_url: str,
) -> None:
    """Apply pending migrations for every plugin with a ``migrations:`` stanza.

    Iterates ``plugins`` in the order the loader returned (topological
    over ``depends_on`` per `docs/002 §4`). Plugins without a
    ``migrations:`` stanza are skipped silently. The first plugin
    failure aborts the whole run (`docs/002 §4.3`).
    """
    for loaded in plugins:
        await _apply_one(loaded, database_url)


async def downgrade_plugin_migrations(
    plugins: list[LoadedPlugin],
    *,
    database_url: str,
) -> None:
    """Reverse of :func:`apply_plugin_migrations` for the uninstall path.

    Walks ``plugins`` in **reverse** order (the caller has already
    sliced the topologically-sorted list to the plugins targeted for
    removal; reversing here means a plugin's downgrade runs before any
    plugin it depends on, mirroring `docs/001 §2.3`). Plugins without
    a ``migrations:`` stanza are skipped silently — there is no schema
    to drop in that case.
    """
    for loaded in reversed(plugins):
        await _downgrade_one(loaded, database_url)


def run_plugin_migrations_sync(plugins_dir: Path, database_url: str) -> None:
    """Sync entry point used by ``eidan admin db migrate``.

    Loads plugins from ``plugins_dir``, then drives
    :func:`apply_plugin_migrations` under :func:`asyncio.run`. The CLI
    wraps any exception into a non-zero exit code; this function lets
    the exception propagate so the operator sees a real traceback.
    """
    loaded = load_plugins(plugins_dir)
    asyncio.run(apply_plugin_migrations(loaded, database_url=database_url))


__all__ = [
    "apply_plugin_migrations",
    "downgrade_plugin_migrations",
    "run_plugin_migrations_sync",
    "schema_for_plugin",
]
