"""Shared Alembic env for plugin-private migrations.

Plugins co-locate their migration history under
``plugins/<name>/migrations/versions/`` (`docs/001 §4.1`). The host
runs that history against the plugin's own ``plugin_<name_underscored>``
schema and tracks it in a ``plugin_<name>.alembic_version`` table.
Rather than asking every plugin author to ship their own ``env.py``,
:mod:`eidan_backend.plugins.migrations` points Alembic at this single
shared env and parameterises it per-plugin via ``cfg.attributes``:

- ``plugin_name`` — manifest name; used only for diagnostics.
- ``plugin_schema`` — the ``plugin_<name_underscored>`` target schema.
- ``database_url`` — the async-form ``postgresql+asyncpg://...`` URL
  the runner resolved (the same URL the operator set as
  ``DATABASE_URL`` for ``eidan admin db migrate``).

The env mirrors the core ``migrations/env.py`` shape: async engine,
``CREATE SCHEMA IF NOT EXISTS`` + ``SET search_path`` inside
``begin_transaction`` so SQLAlchemy 2.0's auto-begin doesn't degrade
Alembic's transaction to a no-commit ``MockTransaction``.
"""

from __future__ import annotations

import asyncio
import os

from alembic import context
from sqlalchemy import pool, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

config = context.config

plugin_schema: str | None = config.attributes.get("plugin_schema")
plugin_name: str | None = config.attributes.get("plugin_name")
database_url: str | None = config.attributes.get("database_url") or os.environ.get(
    "DATABASE_URL"
)

if not plugin_schema:
    raise RuntimeError(
        "plugin_schema not provided to plugin alembic env; this env is "
        "driven by eidan_backend.plugins.migrations and expects "
        "cfg.attributes['plugin_schema'] to be set."
    )
if not database_url:
    raise RuntimeError(
        "DATABASE_URL is not set and cfg.attributes['database_url'] was "
        "not provided. The plugin migration runner cannot run without a "
        "database URL."
    )

config.set_main_option("sqlalchemy.url", database_url)

target_metadata = None


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table="alembic_version",
        version_table_schema=plugin_schema,
        include_schemas=True,
    )
    with context.begin_transaction():
        connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{plugin_schema}"'))
        connection.execute(text(f'SET search_path TO "{plugin_schema}", public'))
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_offline() -> None:
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        version_table="alembic_version",
        version_table_schema=plugin_schema,
        include_schemas=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
