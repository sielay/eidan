# SPDX-License-Identifier: AGPL-3.0-or-later
"""Native JWT issue + verify (`docs/011 §11`).

Replaces the Supabase JWKS round-trip in
:mod:`eidan_backend.http.auth`. Access tokens are RS256 JWTs signed
with the keypair from :mod:`.keys`; refresh tokens are opaque
random strings whose hashes are stored in ``eidan.auth_sessions``
so the host can revoke a single session without invalidating other
active access tokens.

Claim shape mirrors the Supabase token shape Eidan already trusts
elsewhere — ``sub`` is the user UUID, ``email`` is the operator's
address, ``aud`` is ``"eidan"``, ``iss`` is also ``"eidan"`` — so
downstream code that pulled ``identity.user_id`` keeps working
verbatim.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256

from jose import jwt
from jose.exceptions import JWTError

# Token lifetimes pinned in docs/011 §11.2. Tunable later if the
# operator-community settles on different defaults.
ACCESS_TOKEN_TTL_MINUTES = 60 * 24       # 24h
REFRESH_TOKEN_TTL_DAYS = 30              # 30d

_ALGORITHM = "RS256"
_ISSUER = "eidan"
_AUDIENCE = "eidan"


class InvalidToken(Exception):
    """Raised when a JWT fails signature / expiry / audience checks.

    Distinct from :class:`jose.JWTError` so callers (e.g. the auth
    middleware) can map it onto Eidan's typed auth error envelope
    without leaking jose-specific names.
    """


@dataclass(frozen=True, slots=True)
class NativeIdentity:
    """The verified claims from an access token.

    Shape-compatible with :class:`eidan_backend.identity.Identity`
    in the fields downstream code actually reads (``user_id``,
    ``email``). Constructed by :func:`verify_access_token` after a
    successful signature + claim check.
    """

    user_id: str
    email: str
    expires_at: datetime
    issued_at: datetime
    session_id: str | None = None


def issue_access_token(
    *,
    private_pem: bytes,
    user_id: str,
    email: str,
    session_id: str | None = None,
    now: datetime | None = None,
) -> str:
    """Mint an access JWT for ``user_id``.

    ``session_id`` (when set) ties the access token back to the
    refresh-token row in ``eidan.auth_sessions``. Logout revokes the
    session row; the access token then expires naturally at its
    TTL. Within that window the access token still works — same
    posture every other token-based system uses; the alternative
    (per-request revocation check) puts a DB hit on every API call.

    ``now`` overridable for tests; production omits it.
    """
    now = now or datetime.now(UTC)
    expires_at = now + timedelta(minutes=ACCESS_TOKEN_TTL_MINUTES)
    claims = {
        "sub": user_id,
        "email": email,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
        "iss": _ISSUER,
        "aud": _AUDIENCE,
        "type": "access",
    }
    if session_id is not None:
        claims["sid"] = session_id
    return jwt.encode(claims, private_pem.decode("ascii"), algorithm=_ALGORITHM)


def verify_access_token(
    token: str,
    *,
    public_pem: bytes,
    now: datetime | None = None,
) -> NativeIdentity:
    """Verify signature + claims and return :class:`NativeIdentity`.

    Raises :class:`InvalidToken` on any verification failure (bad
    signature, expired, wrong audience, missing fields). The error
    message is operator-facing; never leaked to the client.
    """
    try:
        claims = jwt.decode(
            token,
            public_pem.decode("ascii"),
            algorithms=[_ALGORITHM],
            audience=_AUDIENCE,
            issuer=_ISSUER,
        )
    except JWTError as exc:
        raise InvalidToken(str(exc)) from exc

    # ``type`` distinguishes access vs refresh — refresh tokens are
    # opaque and shouldn't be JWTs, but a defensive check is cheap.
    if claims.get("type") != "access":
        raise InvalidToken("expected an access token")

    user_id = claims.get("sub")
    email = claims.get("email")
    if not user_id or not email:
        raise InvalidToken("token missing sub or email")

    iat = claims.get("iat")
    exp = claims.get("exp")
    if iat is None or exp is None:
        raise InvalidToken("token missing iat or exp")

    return NativeIdentity(
        user_id=str(user_id),
        email=str(email),
        issued_at=datetime.fromtimestamp(int(iat), tz=UTC),
        expires_at=datetime.fromtimestamp(int(exp), tz=UTC),
        session_id=claims.get("sid"),
    )


def mint_refresh_token() -> tuple[str, str]:
    """Mint a fresh refresh token and its storage hash.

    Returns ``(raw, sha256_hex)`` — the raw token goes into the
    httpOnly cookie the browser keeps, the hash is what
    ``eidan.auth_sessions.refresh_token_hash`` stores. A DB dump
    alone can't be replayed as a refresh; the raw token is only ever
    known to the legitimate session holder.

    Length: 48 urlsafe-base64 chars (~288 bits of entropy), well
    above the 128-bit floor for opaque token recommendations.
    """
    raw = secrets.token_urlsafe(36)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    """SHA-256-hex the refresh token for storage / lookup.

    Public helper so the verify endpoint can hash an incoming token
    and look up the row without re-importing hashlib.
    """
    return sha256(raw.encode("ascii")).hexdigest()


def refresh_expiry(now: datetime | None = None) -> datetime:
    """Helper used by the verify endpoint when writing the session
    row. Centralised so the TTL constant has one source of truth.
    """
    now = now or datetime.now(UTC)
    return now + timedelta(days=REFRESH_TOKEN_TTL_DAYS)


__all__ = [
    "ACCESS_TOKEN_TTL_MINUTES",
    "REFRESH_TOKEN_TTL_DAYS",
    "InvalidToken",
    "NativeIdentity",
    "hash_refresh_token",
    "issue_access_token",
    "mint_refresh_token",
    "refresh_expiry",
    "verify_access_token",
]
