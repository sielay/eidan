# SPDX-License-Identifier: AGPL-3.0-or-later
"""API key authentication for A2A and other stateless integrations.

API keys are stored encrypted in eidan.secrets_vault, scoped to their
usage context (e.g., "a2a", "plugin_webhook"). Each key maps to a
user_id (and optionally a scope/role).

Key storage format in vault:
    Vault scope: ``<context>`` (e.g., "a2a" for A2A keys)
    Vault key: ``keys.<key_id>`` or ``api_key_<hash>``
    Vault value: JSON
        {
            "user_id": "uuid-of-authorized-user",
            "scope": "optional-role-or-scope",
            "created_at": "ISO8601",
            "expires_at": "ISO8601-or-null"
        }

Validation:
1. Extract key from Authorization header
2. Hash the key to derive a lookup ID (or use plaintext if short-lived)
3. Query vault for the key's metadata
4. Check expiry (if present)
5. Return the associated user_id

This is intentionally simple: operators provision keys via the vault,
not via a dedicated /api/keys endpoint. No key rotation, revocation, or
usage logging — those are operator concerns handled via vault updates.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from asyncpg import Pool

logger = logging.getLogger(__name__)


class APIKeyNotFound(Exception):
    """Raised when an API key cannot be found or validated."""


class APIKeyExpired(Exception):
    """Raised when an API key has expired."""


async def validate_api_key(
    api_key: str,
    *,
    scope: str,
    secret_accessor: Any,
) -> tuple[str, str | None]:
    """Validate an API key and return the associated user_id + optional scope.

    The key is looked up in the vault under the provided scope. Returns
    (user_id, role_scope) on success.

    Raises APIKeyNotFound or APIKeyExpired on failure.

    Args:
        api_key: The raw API key string.
        scope: The vault scope context (e.g., "a2a").
        secret_accessor: Async callable to fetch secrets from vault.

    Returns:
        Tuple of (user_id, optional_scope).
    """
    if not api_key or not isinstance(api_key, str):
        raise APIKeyNotFound("invalid API key")

    # Hash the API key to derive a fixed-size, non-reversible lookup ID.
    api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()
    vault_key = f"{scope}.keys.{api_key_hash}"

    try:
        key_metadata = await secret_accessor(vault_key)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[api_keys] vault lookup failed for %s", vault_key)
        raise APIKeyNotFound("API key not found or inaccessible") from exc

    if not key_metadata:
        raise APIKeyNotFound("API key not found in vault")

    # Deserialize metadata
    try:
        if isinstance(key_metadata, str):
            metadata = json.loads(key_metadata)
        else:
            metadata = key_metadata

        user_id = metadata.get("user_id")
        if not user_id:
            raise ValueError("key metadata missing user_id")

        role_scope = metadata.get("scope")

        # Check expiry if present
        expires_at_str = metadata.get("expires_at")
        if expires_at_str:
            expires_at = datetime.fromisoformat(expires_at_str)
            if datetime.now(tz=UTC) > expires_at:
                raise APIKeyExpired(f"API key expired at {expires_at_str}")

        return user_id, role_scope

    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        raise APIKeyNotFound(f"invalid key metadata: {exc}") from exc


async def provision_api_key(
    user_id: str,
    *,
    scope: str,
    key_id: str,
    pool: Pool,
    role_scope: str | None = None,
    expires_at: datetime | None = None,
) -> str:
    """Provision a new API key and store it in the vault.

    This is typically called by operators via a management CLI or dashboard,
    not by user code. The key is encrypted before storage. The raw key is
    returned only at creation time and never stored in plaintext.

    Args:
        user_id: The user this key authorizes.
        scope: The vault scope context.
        key_id: A short unique identifier for this key (e.g., "ci-integration").
        pool: Database pool for vault writes.
        role_scope: Optional role/scope (e.g., "admin", "read-only").
        expires_at: Optional expiration datetime.

    Returns:
        The raw API key string (returned only at creation time).
    """
    import secrets

    from .vault_crypto import encrypt_value

    # Generate a cryptographically secure key
    api_key = secrets.token_urlsafe(32)

    # Hash the API key for vault lookup (never store the plaintext key)
    api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    # Metadata to store in vault (includes key_id for reference)
    metadata = {
        "key_id": key_id,
        "user_id": user_id,
        "scope": role_scope,
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    if expires_at:
        metadata["expires_at"] = expires_at.isoformat()

    metadata_json = json.dumps(metadata).encode("utf-8")
    ciphertext = encrypt_value(metadata_json)

    vault_scope = scope
    vault_key = f"keys.{api_key_hash}"

    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.secrets_vault (scope, key, value_enc)
                VALUES ($1, $2, $3)
                ON CONFLICT (scope, key) DO UPDATE
                SET value_enc = EXCLUDED.value_enc
                """,
                vault_scope,
                vault_key,
                ciphertext,
            )
        logger.info(
            "[api_keys] provisioned key %s for user %s in scope %s",
            key_id,
            user_id,
            scope,
        )
        return api_key
    except Exception as exc:
        logger.exception(
            "[api_keys] failed to provision key %s",
            key_id,
        )
        raise


__all__ = [
    "APIKeyNotFound",
    "APIKeyExpired",
    "provision_api_key",
    "validate_api_key",
]
