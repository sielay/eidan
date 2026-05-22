# SPDX-License-Identifier: AGPL-3.0-or-later
"""Magic-link issue + consume (`docs/011 §14`).

The flow:

1. Browser POSTs an email to ``/api/auth/magic-link``.
2. The handler calls :func:`issue_magic_link` here, which:
   - rejects the email if it doesn't match the allow-list,
   - mints a random token + a 6-digit code,
   - writes a row to ``eidan.auth_magic_links`` with a 15-min TTL,
   - returns the raw token (the route then emails it + logs in dev).
3. The user clicks the magic link OR pastes the code.
4. The browser POSTs ``/api/auth/verify`` with the token (or code).
5. :func:`consume_magic_link` looks the row up by token hash,
   atomic-marks it consumed, and returns the email. The verify
   handler then mints the JWT pair.

The TOKEN is what the email URL carries (long, opaque, urlsafe).
The CODE is the 6-digit number for the paste-back path (some
mobile mail clients mangle URLs). Both reference the same row;
consuming either marks both unusable.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any

from .allowed_email import email_is_allowed

# 15-minute TTL pinned in docs/011 §14.2. Short enough that a stolen
# email link can't be replayed days later; long enough that the
# operator can paste the code on a different device.
MAGIC_LINK_TTL_MINUTES = 15

# 6 digits is enough entropy paired with the 15-min window + rate
# limiting (10 attempts per IP per hour, enforced at the verify
# endpoint). 8 digits would be ergonomically worse without a
# meaningful security gain.
_CODE_DIGITS = 6


class MagicLinkUnauthorized(Exception):
    """Raised when the supplied email isn't in the allow-list.

    The route handler maps this to a generic 202 (so an attacker
    probing for valid emails sees the same response shape). Logged
    server-side at WARN so operator monitoring can catch a spike.
    """


class MagicLinkExpired(Exception):
    """Verify-side error: token expired or already consumed."""


class MagicLinkNotFound(Exception):
    """Verify-side error: token / code didn't match any row."""


@dataclass(frozen=True, slots=True)
class IssuedMagicLink:
    """Returned by :func:`issue_magic_link` to the route handler.

    The route emails ``token`` to the user (typically as part of a
    URL like ``https://eidan.example/login?token=<token>``) and
    optionally shows ``code`` in dev for paste-back. The DB row is
    already persisted by the time this is returned.
    """

    email: str
    token: str
    code: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ConsumedMagicLink:
    """Returned by :func:`consume_magic_link` after a successful
    exchange. The email field is what the verify handler then uses
    to upsert ``eidan.users`` + mint the session.
    """

    email: str


def _hash(token: str) -> str:
    """SHA-256 hex of the raw token — what we store, what we look
    up. The raw token is never persisted."""
    return sha256(token.encode("ascii")).hexdigest()


def _random_code() -> str:
    """Zero-padded numeric code. ``secrets`` for entropy."""
    n = secrets.randbelow(10**_CODE_DIGITS)
    return str(n).zfill(_CODE_DIGITS)


async def issue_magic_link(
    conn: Any,
    *,
    email: str,
    now: datetime | None = None,
) -> IssuedMagicLink:
    """Mint a magic link for ``email`` and persist its hash.

    Raises :class:`MagicLinkUnauthorized` when the email isn't in
    the allow-list. The route maps that to a 202 with a generic
    message so a probing attacker can't enumerate valid emails.

    ``conn`` is an ``asyncpg.Connection`` (typed ``Any`` to keep
    this module dependency-light).
    """
    if not email_is_allowed(email):
        raise MagicLinkUnauthorized(email)

    now = now or datetime.now(UTC)
    expires_at = now + timedelta(minutes=MAGIC_LINK_TTL_MINUTES)
    token = secrets.token_urlsafe(36)
    token_hash = _hash(token)
    code = _random_code()

    await conn.execute(
        """
        INSERT INTO eidan.auth_magic_links
            (email, token_hash, code, expires_at)
        VALUES ($1, $2, $3, $4)
        """,
        email.strip().lower(),
        token_hash,
        code,
        expires_at,
    )
    return IssuedMagicLink(
        email=email.strip().lower(),
        token=token,
        code=code,
        expires_at=expires_at,
    )


async def consume_magic_link(
    conn: Any,
    *,
    token: str | None = None,
    code: str | None = None,
    now: datetime | None = None,
) -> ConsumedMagicLink:
    """Atomically consume a magic link by token or by code.

    Raises:
        :class:`MagicLinkNotFound` — no matching row.
        :class:`MagicLinkExpired` — row exists but expired or already
        consumed.

    Exactly one of ``token`` / ``code`` must be set. The CODE path
    is used when the operator pastes the 6-digit code from the email
    instead of clicking the URL.

    Implementation note: a single UPDATE with a RETURNING clause and
    a WHERE that gates on (not consumed) and (not expired) is the
    canonical "claim a row atomically" pattern — no read-then-write
    race.
    """
    if (token is None) == (code is None):
        raise ValueError("exactly one of token/code must be set")

    now = now or datetime.now(UTC)
    if token is not None:
        predicate_column = "token_hash"
        predicate_value: str = _hash(token)
    else:
        # ``code`` path
        assert code is not None  # type-narrow for mypy
        predicate_column = "code"
        predicate_value = code

    row = await conn.fetchrow(
        f"""
        UPDATE eidan.auth_magic_links
        SET consumed_at = $1
        WHERE {predicate_column} = $2
          AND consumed_at IS NULL
          AND expires_at > $1
        RETURNING email
        """,
        now,
        predicate_value,
    )
    if row is not None:
        return ConsumedMagicLink(email=row["email"])

    # Distinguish "no such row" from "row exists but expired /
    # already consumed" — gives the operator a clearer error.
    debug = await conn.fetchrow(
        f"""
        SELECT consumed_at, expires_at
        FROM eidan.auth_magic_links
        WHERE {predicate_column} = $1
        """,
        predicate_value,
    )
    if debug is None:
        raise MagicLinkNotFound()
    raise MagicLinkExpired()


__all__ = [
    "MAGIC_LINK_TTL_MINUTES",
    "ConsumedMagicLink",
    "IssuedMagicLink",
    "MagicLinkExpired",
    "MagicLinkNotFound",
    "MagicLinkUnauthorized",
    "consume_magic_link",
    "issue_magic_link",
]
