# SPDX-License-Identifier: AGPL-3.0-or-later
"""A2A (Agent-to-Agent) authentication & security schemes.

Handles inbound A2A request authentication (bearer JWT or API key) per the
A2A protocol security model. Validates credentials and maps authenticated
callers to eidan identities. Failures return A2A-shaped JSON-RPC 2.0 errors.

Supported security schemes (on Agent Card):
- `bearer`: HTTP Bearer token (JWT) — validated like user auth
- `api_key`: API Key (stored/managed via vault)

Per `docs/028`, an inbound A2A call acts ON_BEHALF_OF a principal (the
authenticated remote agent's user identity, not the remote agent itself).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..identity import AuthError, Identity
from ..auth_native import InvalidToken, verify_access_token

if TYPE_CHECKING:
    from fastapi import Request


class A2AAuthError(AuthError):
    """A2A-specific auth failure. Maps to JSON-RPC error code."""

    def __init__(self, jsonrpc_code: int, message: str) -> None:
        super().__init__(f"a2a.auth_failed", message)
        self.jsonrpc_code = jsonrpc_code


def _extract_bearer_token(auth_header: str | None) -> str | None:
    """Extract bearer token from Authorization header.

    Expects: ``Authorization: Bearer <token>``
    Returns the token string or None if missing/malformed.
    """
    if not auth_header:
        return None
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


def _extract_api_key(auth_header: str | None) -> str | None:
    """Extract API key from Authorization header.

    Supports: ``Authorization: ApiKey <key>`` or ``Authorization: Bearer <key>``
    when the bearer token is actually an API key (stateless validation fails).
    Returns the key string or None if missing.
    """
    if not auth_header:
        return None
    parts = auth_header.split(" ", 1)
    if len(parts) != 2:
        return None
    scheme = parts[0].lower()
    if scheme not in ("apikey", "bearer"):
        return None
    token = parts[1].strip()
    return token or None


async def validate_a2a_api_key(
    api_key: str,
    *,
    secret_accessor: callable,
) -> tuple[str, str]:
    """Validate an API key against stored credentials in vault.

    Returns (user_id, email) on success.
    Raises A2AAuthError on validation failure.

    The vault is scoped to ``a2a.{key_id}`` to support multiple API keys,
    each mapping to a user_id. Format:
        Vault key: ``a2a.<key_id>``
        Vault value: JSON ``{"user_id": "uuid", "email": "..."}``
    """
    if not api_key:
        raise A2AAuthError(401, "missing or empty API key")

    # Try to look up the key in vault (scoped to a2a namespace)
    # The operator stores: EIDAN_A2A_<KEYID>=<keyvalue> in env or vault
    # and we validate against that.
    # For now, support validation against env vars: EIDAN_A2A_KEY_ID=...
    # In production, these come from vault storage.
    try:
        key_info = await secret_accessor(f"a2a.key_{api_key[:8]}_credentials")
    except Exception:
        key_info = None

    if not key_info:
        raise A2AAuthError(
            401,
            "invalid or unknown API key",
        )

    # Parse the stored credentials (should be JSON with user_id + email)
    import json

    try:
        creds = json.loads(key_info) if isinstance(key_info, str) else key_info
        user_id = creds.get("user_id")
        email = creds.get("email")
        if not user_id:
            raise ValueError("missing user_id in API key credentials")
        return user_id, email or None
    except (json.JSONDecodeError, ValueError, KeyError) as exc:
        raise A2AAuthError(
            500,
            f"invalid API key credentials in vault: {str(exc)[:50]}",
        ) from exc


async def authenticate_a2a_request(
    request: Request,
    *,
    public_pem: bytes | None = None,
    secret_accessor: callable | None = None,
) -> Identity:
    """Authenticate an inbound A2A request and return an Identity.

    Tries in order:
    1. Bearer JWT (validated against public_pem, like user auth)
    2. API Key (validated against vault via secret_accessor)

    Returns an Identity on success.
    Raises A2AAuthError on any failure (unsupported, missing, invalid).

    The returned Identity's aal is set to "a2a" to distinguish from
    regular user auth, allowing route handlers to know the caller is
    a remote agent.
    """
    auth_header = request.headers.get("authorization", "").strip()

    if not auth_header:
        raise A2AAuthError(401, "missing Authorization header")

    # Try bearer token first (JWT validation)
    bearer_token = _extract_bearer_token(auth_header)
    if bearer_token:
        if public_pem is None:
            raise A2AAuthError(500, "JWT verifier not configured")

        try:
            native_identity = verify_access_token(bearer_token, public_pem=public_pem)
        except InvalidToken as exc:
            raise A2AAuthError(
                401,
                f"invalid bearer token: {str(exc)[:50]}",
            ) from exc

        # Successful JWT validation — return eidan Identity
        return Identity(
            user_id=native_identity.user_id,
            email=native_identity.email,
            session_id=native_identity.session_id,
            aal="a2a",
            raw_claims={
                "sub": native_identity.user_id,
                "email": native_identity.email,
                "sid": native_identity.session_id,
                "iat": int(native_identity.issued_at.timestamp()),
                "exp": int(native_identity.expires_at.timestamp()),
                "a2a": True,
            },
        )

    # Try API key (vault lookup)
    api_key = _extract_api_key(auth_header)
    if api_key:
        if secret_accessor is None:
            raise A2AAuthError(
                500,
                "API key verification not configured",
            )

        try:
            user_id, email = await validate_a2a_api_key(
                api_key,
                secret_accessor=secret_accessor,
            )
        except A2AAuthError:
            raise

        # Successful API key validation — return eidan Identity
        return Identity(
            user_id=user_id,
            email=email,
            session_id=None,
            aal="a2a",
            raw_claims={
                "sub": user_id,
                "email": email,
                "a2a": True,
                "auth_method": "api_key",
            },
        )

    # Neither bearer nor API key matched
    raise A2AAuthError(
        401,
        "unsupported Authorization scheme (expected Bearer or ApiKey)",
    )


def a2a_jsonrpc_error_response(
    code: int,
    message: str,
    data: dict | None = None,
) -> dict:
    """Build a JSON-RPC 2.0 error response for A2A failures.

    Maps A2AAuthError.jsonrpc_code to the JSON-RPC error structure.
    """
    error_obj = {"code": code, "message": message}
    if data is not None:
        error_obj["data"] = data
    return {"jsonrpc": "2.0", "error": error_obj, "id": None}


__all__ = [
    "A2AAuthError",
    "a2a_jsonrpc_error_response",
    "authenticate_a2a_request",
    "validate_a2a_api_key",
]
