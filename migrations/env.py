"""Alembic env for the eidan schema.

Reads DATABASE_URL from the environment (no sqlalchemy.url in alembic.ini).
Runs in async mode against asyncpg. Targets the `eidan` schema; the search
path is set in `do_run_migrations` and the schema is created if it does not
exist yet (idempotent).
"""

from __future__ import annotations

import asyncio
import os

from alembic import context
from sqlalchemy import pool, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

config = context.config

# Resolve the migration connection from the environment. Migrations take a
# *session-level* advisory lock (plugin host-schema serialisation), which a
# transaction-mode pooler (Supabase :6543) would route across multiplexed
# connections and break. So prefer an explicit direct (:5432) URL when set,
# falling back to DATABASE_URL for the common single-connection setup.
# The CLI / `eidan admin db migrate` sets these; this module loads no .env.
database_url = (
    os.environ.get("EIDAN_DATABASE_DIRECT_URL")
    or os.environ.get("DIRECT_URL")
    or os.environ.get("DATABASE_URL")
)
if not database_url:
    raise RuntimeError(
        "No migration DB URL set. Set EIDAN_DATABASE_DIRECT_URL (a direct "
        ":5432 connection, recommended when DATABASE_URL is a transaction "
        "pooler) or DATABASE_URL. `eidan admin db migrate` sets it for you."
    )

config.set_main_option("sqlalchemy.url", database_url)

# Models will be importable here once the first migration's schema is in
# code (Phase 1.b). Until then, autogeneration is intentionally disabled —
# every Phase 1 migration is hand-written.
target_metadata = None


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table="alembic_version",
        version_table_schema="eidan",
        include_schemas=True,
    )
    # Schema + search_path setup must live INSIDE begin_transaction(). On
    # SQLAlchemy 2.0 a bare connection.execute() auto-begins a transaction,
    # and alembic's begin_transaction() then degrades to a MockTransaction
    # (no commit) — every migration would be applied and silently rolled
    # back on connection close.
    with context.begin_transaction():
        connection.execute(text("CREATE SCHEMA IF NOT EXISTS eidan"))
        connection.execute(text("SET search_path TO eidan, public"))
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
    """Render the SQL to stdout without a live connection."""
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        version_table="alembic_version",
        version_table_schema="eidan",
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
