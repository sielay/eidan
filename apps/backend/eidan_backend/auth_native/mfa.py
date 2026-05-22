# SPDX-License-Identifier: AGPL-3.0-or-later
"""TOTP scaffold for native MFA (`docs/011 §18`).

RFC 6238 time-based one-time passwords. The operator opts in via
``eidan auth mfa enrol`` (CLI lands in a later commit) which:

1. Generates a 20-byte secret.
2. Encrypts it with the vault key and inserts a row into
   ``eidan.auth_mfa_totp``.
3. Returns the secret + ``otpauth://`` URI the operator scans into
   their authenticator app.
4. Asks the operator for the first code; on match, stamps
   ``verified_at`` so the row counts as active.

Verification on subsequent logins is gated by the verify endpoint
checking ``is_totp_required(user_id)`` after the magic link
consumes; if MFA is enabled, the endpoint returns a partial-auth
response and the UI prompts for the code, then POSTs to
``/api/auth/verify-totp`` (Phase 5+).

Today the module ships the primitives; the endpoint wiring lands
when the frontend MFA prompt is built.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from typing import Any
from urllib.parse import quote
from uuid import UUID

from .vault_crypto import decrypt_value, encrypt_value

# RFC 6238 defaults.
_TIME_STEP_SECONDS = 30
_DIGITS = 6
_WINDOW_TOLERANCE = 1  # accept previous + current + next step


def _generate_secret() -> bytes:
    """20 bytes of CSPRNG entropy — the size Google Authenticator
    et al. agree on for SHA-1 TOTP."""
    return secrets.token_bytes(20)


def _hotp(secret: bytes, counter: int) -> str:
    """RFC 4226 HOTP, used as TOTP's primitive."""
    msg = struct.pack(">Q", counter)
    digest = hmac.new(secret, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = (
        (digest[offset] & 0x7F) << 24
        | (digest[offset + 1] & 0xFF) << 16
        | (digest[offset + 2] & 0xFF) << 8
        | (digest[offset + 3] & 0xFF)
    )
    return str(binary % (10 ** _DIGITS)).zfill(_DIGITS)


def _totp_now(secret: bytes, *, at: float | None = None) -> str:
    """Return the current TOTP code. ``at`` overridable for tests."""
    now = at if at is not None else time.time()
    counter = int(now // _TIME_STEP_SECONDS)
    return _hotp(secret, counter)


def _totp_matches(secret: bytes, candidate: str, *, at: float | None = None) -> bool:
    """Constant-time check against ±1 time step (the spec's
    suggested clock-drift tolerance)."""
    if not candidate or not candidate.isdigit() or len(candidate) != _DIGITS:
        return False
    now = at if at is not None else time.time()
    counter = int(now // _TIME_STEP_SECONDS)
    for offset in range(-_WINDOW_TOLERANCE, _WINDOW_TOLERANCE + 1):
        if hmac.compare_digest(_hotp(secret, counter + offset), candidate):
            return True
    return False


def otpauth_uri(*, secret: bytes, account: str, issuer: str = "eidan") -> str:
    """Build the ``otpauth://`` URI authenticator apps consume.

    The secret is base32-encoded per the de-facto standard. ``issuer``
    is what shows up as the label in the app.
    """
    encoded = base64.b32encode(secret).decode("ascii").rstrip("=")
    label = f"{issuer}:{account}"
    return (
        f"otpauth://totp/{quote(label, safe=':@')}?"
        f"secret={encoded}&issuer={quote(issuer)}&digits={_DIGITS}&period={_TIME_STEP_SECONDS}"
    )


async def enrol_totp(conn: Any, *, user_id: UUID, account: str) -> tuple[bytes, str]:
    """Mint a fresh TOTP secret for ``user_id``.

    Returns ``(secret_raw, otpauth_uri)``. The secret is persisted
    encrypted in ``eidan.auth_mfa_totp``; ``verified_at`` stays
    NULL until :func:`verify_and_activate_totp` records a
    successful first code from the operator.

    Idempotent: re-enrolling overwrites the secret (operator might
    have lost their authenticator + needs to re-pair).
    """
    secret = _generate_secret()
    enc = encrypt_value(secret)
    await conn.execute(
        """
        INSERT INTO eidan.auth_mfa_totp (user_id, secret_enc)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE
        SET secret_enc = EXCLUDED.secret_enc,
            verified_at = NULL,
            created_at = now()
        """,
        user_id,
        enc,
    )
    return secret, otpauth_uri(secret=secret, account=account)


async def verify_and_activate_totp(
    conn: Any,
    *,
    user_id: UUID,
    code: str,
) -> bool:
    """First-time verify after enrolment.

    On a matching code, stamps ``verified_at = now()`` so subsequent
    logins treat the row as active. Returns True on match, False
    otherwise.
    """
    row = await conn.fetchrow(
        "SELECT secret_enc FROM eidan.auth_mfa_totp WHERE user_id = $1",
        user_id,
    )
    if row is None:
        return False
    secret = decrypt_value(bytes(row["secret_enc"]))
    if not _totp_matches(secret, code):
        return False
    await conn.execute(
        "UPDATE eidan.auth_mfa_totp SET verified_at = now() WHERE user_id = $1",
        user_id,
    )
    return True


async def verify_totp_for_login(
    conn: Any,
    *,
    user_id: UUID,
    code: str,
) -> bool:
    """Login-time verify (post-enrolment).

    Returns True iff the row is active (``verified_at IS NOT NULL``)
    AND the code matches. The login endpoint refuses to issue tokens
    if this returns False once MFA is enabled.
    """
    row = await conn.fetchrow(
        """
        SELECT secret_enc
        FROM eidan.auth_mfa_totp
        WHERE user_id = $1 AND verified_at IS NOT NULL
        """,
        user_id,
    )
    if row is None:
        return False
    secret = decrypt_value(bytes(row["secret_enc"]))
    return _totp_matches(secret, code)


async def is_totp_required(conn: Any, *, user_id: UUID) -> bool:
    """Predicate the verify endpoint uses to decide between
    issuing tokens directly vs requesting a TOTP code first."""
    row = await conn.fetchval(
        """
        SELECT 1
        FROM eidan.auth_mfa_totp
        WHERE user_id = $1 AND verified_at IS NOT NULL
        """,
        user_id,
    )
    return row is not None


async def disable_totp(conn: Any, *, user_id: UUID) -> None:
    """Remove the row entirely. Re-enrolment goes through the full
    pair-then-verify flow."""
    await conn.execute(
        "DELETE FROM eidan.auth_mfa_totp WHERE user_id = $1",
        user_id,
    )


__all__ = [
    "disable_totp",
    "enrol_totp",
    "is_totp_required",
    "otpauth_uri",
    "verify_and_activate_totp",
    "verify_totp_for_login",
]
