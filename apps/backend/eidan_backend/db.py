"""asyncpg connection management.

One pool per process. Connections set `search_path = eidan, public` on
connect so every query the agent loop runs lands in the eidan schema
without needing a prefix. Per `docs/011 §9.3`, ``acquire()`` also opens
a transaction and issues ``SET LOCAL eidan.current_user_id`` (and
friends) — uniformity means the RLS plugin's policies (`docs/002 §5.2`)
work on day one of an install with zero core-side change.
"""

from __future__ import annotations

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
    """
    return await asyncpg.create_pool(
        _strip_sqlalchemy_prefix(database_url),
        min_size=1,
        max_size=10,
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
