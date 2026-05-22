# SPDX-License-Identifier: AGPL-3.0-or-later
"""Refresh-token session storage (`docs/011 §15`).

Each successful verify mints a refresh token, hashes it, and stores
the hash in ``eidan.auth_sessions`` with a 30-day TTL. The raw
refresh lives only in the operator's httpOnly cookie — a DB dump
alone cannot be replayed.

The access JWT is stateless (verified off the public key); the
refresh row is the revocable handle. Logout = ``UPDATE ... SET
revoked_at = now()`` on the row. A subsequent /api/auth/refresh
with the same cookie fails the lookup (predicate filters
``revoked_at IS NULL``), and the access token expires naturally
within its TTL window.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from .jwt_native import hash_refresh_token, refresh_expiry


class SessionNotFound(Exception):
    """Refresh token doesn't match an active session."""


class SessionExpired(Exception):
    """Refresh token matched a session that's expired or revoked."""


async def create_session(
    conn: Any,
    *,
    user_id: UUID,
    raw_refresh: str,
    user_agent: str | None = None,
    ip_address: str | None = None,
    now: datetime | None = None,
) -> UUID:
    """Insert an auth_sessions row for a freshly minted refresh.

    Returns the session id, which the verify endpoint stamps into
    the access JWT's ``sid`` claim so revocation propagates to
    future access-token lookups (Phase 2 feature — today access
    tokens just expire naturally).
    """
    now = now or datetime.now(UTC)
    row = await conn.fetchrow(
        """
        INSERT INTO eidan.auth_sessions
            (user_id, refresh_token_hash, expires_at,
             user_agent, ip_address)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        """,
        user_id,
        hash_refresh_token(raw_refresh),
        refresh_expiry(now),
        user_agent,
        ip_address,
    )
    assert row is not None
    return row["id"]


async def lookup_active_session(
    conn: Any,
    *,
    raw_refresh: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Resolve a refresh cookie to its session row.

    Returns the row dict on success (keys: id, user_id, expires_at,
    revoked_at, last_used_at). Raises :class:`SessionNotFound` or
    :class:`SessionExpired` on the unhappy paths. Same shape as
    :func:`consume_magic_link` so callers handle both consistently.
    """
    now = now or datetime.now(UTC)
    row = await conn.fetchrow(
        """
        SELECT id, user_id, expires_at, revoked_at
        FROM eidan.auth_sessions
        WHERE refresh_token_hash = $1
        """,
        hash_refresh_token(raw_refresh),
    )
    if row is None:
        raise SessionNotFound()
    if row["revoked_at"] is not None or row["expires_at"] <= now:
        raise SessionExpired()
    return dict(row)


async def touch_session(
    conn: Any,
    *,
    session_id: UUID,
    now: datetime | None = None,
) -> None:
    """Bump ``last_used_at`` after a successful refresh.

    Cheap; gives the operator an "is this session still being
    used?" signal in the future sessions-inbox UI.
    """
    now = now or datetime.now(UTC)
    await conn.execute(
        """
        UPDATE eidan.auth_sessions
        SET last_used_at = $1
        WHERE id = $2
        """,
        now,
        session_id,
    )


async def revoke_session(
    conn: Any,
    *,
    raw_refresh: str,
    now: datetime | None = None,
) -> bool:
    """Idempotent logout: marks the session revoked.

    Returns True when a row was revoked, False when the refresh
    didn't match any session (e.g. cookie was already cleared client-
    side, or this is a replay of an old logout). The endpoint
    returns 204 either way so an attacker can't enumerate active
    sessions by probing logout.
    """
    now = now or datetime.now(UTC)
    result = await conn.execute(
        """
        UPDATE eidan.auth_sessions
        SET revoked_at = $1
        WHERE refresh_token_hash = $2
          AND revoked_at IS NULL
        """,
        now,
        hash_refresh_token(raw_refresh),
    )
    # asyncpg returns 'UPDATE <n>' for command tag; parse the count.
    parts = result.rsplit(" ", 1) if isinstance(result, str) else []
    return len(parts) == 2 and parts[1] != "0"


__all__ = [
    "SessionExpired",
    "SessionNotFound",
    "create_session",
    "lookup_active_session",
    "revoke_session",
    "touch_session",
]
