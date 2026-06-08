"""asyncpg connection management.

One pool per process. Connections set `search_path = eidan, public` on
connect so every query the agent loop runs lands in the eidan schema
without needing a prefix. Per `docs/011 §9.3`, ``acquire()`` also opens
a transaction and issues ``SET LOCAL eidan.current_user_id`` (and
friends) — uniformity means the RLS plugin's policies (`docs/002 §5.2`)
work on day one of an install with zero core-side change.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg

from .identity import Identity


def _strip_sqlalchemy_prefix(url: str) -> str:
    """asyncpg.connect doesn't accept the +asyncpg dialect suffix."""
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


async def create_pool(database_url: str) -> asyncpg.Pool:
    """Open the process-wide connection pool.

    Caller owns the lifecycle: `await pool.close()` on shutdown.

    **Pool size is env-configurable** (``EIDAN_DB_POOL_MIN_SIZE`` /
    ``EIDAN_DB_POOL_MAX_SIZE``, defaults 1 / 10). A node sharing a
    connection-capped pooler with other nodes can run a small pool
    (e.g. ``EIDAN_DB_POOL_MAX_SIZE=3``) so it doesn't exhaust the budget.

    ``statement_cache_size=0`` lets the pool work through a **transaction-
    mode pooler** (Supabase Supavisor :6543 / PgBouncer): those multiplex
    many clients onto few server connections and can't persist asyncpg's
    per-connection prepared statements across them. Disabling the cache is
    safe in every mode (negligible cost) and removes the session-mode
    client cap. The runtime is transaction-scoped (``SET LOCAL`` in
    :func:`acquire`, ``FOR UPDATE SKIP LOCKED``, ``pg_advisory_xact_lock``),
    so it is transaction-pooler-compatible. **Migrations** use a session
    advisory lock and must run on the direct connection — see
    ``migrations/env.py`` (``EIDAN_DATABASE_DIRECT_URL``).
    """
    min_size = int(os.environ.get("EIDAN_DB_POOL_MIN_SIZE", "1"))
    max_size = int(os.environ.get("EIDAN_DB_POOL_MAX_SIZE", "10"))
    return await asyncpg.create_pool(
        _strip_sqlalchemy_prefix(database_url),
        min_size=min_size,
        max_size=max_size,
        statement_cache_size=0,
        server_settings={"search_path": "eidan, public"},
    )


@asynccontextmanager
async def acquire(
    pool: asyncpg.Pool,
    identity: Identity,
) -> AsyncIterator[asyncpg.Connection]:
    """Borrow a connection, open a transaction, set the eidan.* session vars.

    Per `docs/011 §9.3`, every DB op the agent loop runs is wrapped in
    a transaction with three session variables bound for the duration
    of that transaction:

        BEGIN
        SET LOCAL eidan.current_user_id    = '<identity.user_id>'
        SET LOCAL eidan.current_session_id = '<identity.session_id|"">'
        SET LOCAL eidan.current_aal        = '<identity.aal>'

    Core does not read these variables; uniformity is the point — an
    install that later adds the RLS plugin (`docs/002 §5.2`) finds the
    contract already honoured with no code change in core.

    The transaction commits when the ``async with`` body exits cleanly
    and rolls back if the body raises. Per `docs/011 §9.3` last
    paragraph, the loop holds no transaction across the provider call;
    each ``acquire()`` is short-lived around a single batch of writes.

    A ``None`` ``session_id`` is encoded as ``''`` because
    ``set_config(text, NULL, true)`` is a no-op — RLS policies that
    care about the distinction read ``nullif(current_setting(...), '')``.
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT set_config('eidan.current_user_id', $1, true)",
                identity.user_id,
            )
            await conn.execute(
                "SELECT set_config('eidan.current_session_id', $1, true)",
                identity.session_id or "",
            )
            await conn.execute(
                "SELECT set_config('eidan.current_aal', $1, true)",
                identity.aal,
            )
            yield conn
