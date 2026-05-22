"""CLI login flows against Eidan's native auth surface (`docs/011 §11`).

Two paths under one `eidan login` command:

- **Magic-link** — CLI POSTs to ``/api/auth/magic-link`` on the
  running backend; the backend mails the operator a link + 6-digit
  code (and in dev echoes both on the response). The CLI prompts for
  the code, POSTs ``/api/auth/verify``, and stores the resulting
  access + refresh tokens.
- **Direct paste** — ``eidan login --token <jwt>`` for the power-user
  case (a token minted via the web UI's debug surface, say). No
  round-trip.

The backend URL comes from ``EIDAN_BACKEND_URL`` (defaults to
``http://localhost:8000`` so the dev container's compose stack works
without extra config).
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from .storage import StoredAuth


class LoginError(Exception):
    pass


def _backend_url() -> str:
    return os.environ.get("EIDAN_BACKEND_URL", "http://localhost:8000").rstrip("/")


async def send_magic_link(email: str) -> dict[str, Any]:
    """POST /api/auth/magic-link — backend mails the operator a link.

    Returns the response body. In dev mode that body includes a
    ``magic_link`` URL + ``code`` field so the operator can click
    through without an SMTP setup; in production those fields are
    omitted and the link arrives via email.
    """
    url = f"{_backend_url()}/api/auth/magic-link"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json={"email": email})
        if resp.status_code >= 400:
            raise LoginError(
                f"magic-link request failed: {resp.status_code} {resp.text}"
            )
        return resp.json()


async def verify_code(code: str) -> StoredAuth:
    """POST /api/auth/verify — exchange the 6-digit code for a JWT pair."""
    url = f"{_backend_url()}/api/auth/verify"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json={"code": code})
        if resp.status_code >= 400:
            raise LoginError(
                f"verify failed: {resp.status_code} {resp.text}"
            )
        body: dict[str, Any] = resp.json()
        # The refresh token lives in an httpOnly cookie scoped to
        # /api/auth/refresh; the CLI captures it from the Set-Cookie
        # header so a stored refresh token can drive `eidan repl`
        # past the 24h access-token TTL.
        refresh = resp.cookies.get("eidan_refresh")

    access = body.get("access_token")
    if not access:
        raise LoginError("verify response carried no access_token")
    user = body.get("user") or {}
    return StoredAuth(
        access_token=access,
        refresh_token=refresh,
        expires_at=None,
        email=user.get("email"),
        provider="native",
    )


async def verify_token_url(token: str) -> StoredAuth:
    """POST /api/auth/verify — exchange a click-through token (not a code).

    The web UI uses this when the operator opens the email link in
    the same browser; the CLI exposes it for parity. The token must
    be the URL-safe opaque value from the ``token=…`` query parameter,
    not the 6-digit code.
    """
    url = f"{_backend_url()}/api/auth/verify"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json={"token": token})
        if resp.status_code >= 400:
            raise LoginError(
                f"verify failed: {resp.status_code} {resp.text}"
            )
        body: dict[str, Any] = resp.json()
        refresh = resp.cookies.get("eidan_refresh")

    access = body.get("access_token")
    if not access:
        raise LoginError("verify response carried no access_token")
    user = body.get("user") or {}
    return StoredAuth(
        access_token=access,
        refresh_token=refresh,
        expires_at=None,
        email=user.get("email"),
        provider="native",
    )


def from_pasted_token(token: str) -> StoredAuth:
    """Store a JWT the user pasted in directly. No round-trip."""
    return StoredAuth(
        access_token=token,
        refresh_token=None,
        expires_at=None,
        email=None,
        provider="native",
    )
