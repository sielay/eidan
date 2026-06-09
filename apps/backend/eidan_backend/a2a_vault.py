# SPDX-License-Identifier: AGPL-3.0-or-later
"""Outbound A2A credential management via vault.

When eidan delegates to a remote A2A agent, it needs credentials to
authenticate the outbound request. This module handles storing and
retrieving those credentials via the native vault (`eidan.secrets_vault`),
encrypted at rest.

Credential storage schema:
    Vault scope: ``a2a_remote``
    Vault keys: ``agents.<agent_id>`` → JSON credential object
    Credential object:
        {
            "agent_name": "reviewer",
            "base_url": "https://remote.example.com",
            "auth_method": "bearer" | "api_key",
            "auth_value": "secret-token-or-key"
        }

The operator can populate credentials via:
- Vault CLI: ``eidan secret set a2a_remote.agents.reviewer <json>``
- Environment: ``EIDAN_A2A_REMOTE_AGENTS_REVIEWER`` (less secure, not recommended)
- Direct DB insert into eidan.secrets_vault (for automation)

All credentials are never logged in plaintext; retrieval is on-demand
and decrypted at runtime.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any
from uuid import UUID

if TYPE_CHECKING:
    from .secrets import SecretAccessor

logger = logging.getLogger(__name__)


class A2ACredential:
    """Credential for an outbound A2A agent delegation."""

    def __init__(
        self,
        agent_name: str,
        base_url: str,
        auth_method: str,
        auth_value: str,
    ) -> None:
        self.agent_name = agent_name
        self.base_url = base_url
        self.auth_method = auth_method
        self.auth_value = auth_value

    def to_dict(self) -> dict[str, str]:
        """Serialize to JSON-safe dict for vault storage."""
        return {
            "agent_name": self.agent_name,
            "base_url": self.base_url,
            "auth_method": self.auth_method,
            "auth_value": self.auth_value,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> A2ACredential:
        """Deserialize from vault JSON."""
        return cls(
            agent_name=data.get("agent_name", ""),
            base_url=data.get("base_url", ""),
            auth_method=data.get("auth_method", "bearer"),
            auth_value=data.get("auth_value", ""),
        )


class A2AVaultManager:
    """Manager for storing and retrieving A2A credentials via vault.

    Integrates with the native vault (eidan.secrets_vault) to store
    credentials envelope-encrypted. Credentials are never in plaintext
    config — all access goes through the vault tier.
    """

    # Vault scope for all A2A remote agent credentials
    _VAULT_SCOPE = "a2a_remote"

    def __init__(self, secret_accessor: SecretAccessor) -> None:
        """Initialize with the secret accessor from the turn context.

        The accessor is passed by the A2A delegation tool at runtime,
        so credentials can be fetched with the current agent's identity
        and any per-agent overrides.
        """
        self.secret_accessor = secret_accessor

    def _vault_key_for_agent(self, agent_id: str) -> str:
        """Build the vault lookup key for an agent's credentials.

        Format: ``a2a_remote.agents.<agent_id>``
        """
        return f"a2a_remote.agents.{agent_id}"

    async def get_credential(self, agent_id: str) -> A2ACredential | None:
        """Retrieve credential for a remote A2A agent.

        Returns the credential on success, or None if not found/invalid.
        Logs warnings on retrieval/decode failures but does not raise,
        so a missing credential surfaces cleanly to the delegating agent.

        Args:
            agent_id: The remote agent's identifier (e.g. "reviewer").

        Returns:
            A2ACredential on success, None if not found or invalid.
        """
        vault_key = self._vault_key_for_agent(agent_id)

        try:
            credential_json = await self.secret_accessor(vault_key)
        except Exception:  # noqa: BLE001 — don't block delegation on vault errors
            logger.exception(
                "[a2a_vault] failed to retrieve credential for %s",
                agent_id,
            )
            return None

        if not credential_json:
            logger.debug(
                "[a2a_vault] no credential found for agent %s",
                agent_id,
            )
            return None

        # Deserialize JSON
        try:
            if isinstance(credential_json, str):
                cred_data = json.loads(credential_json)
            else:
                cred_data = credential_json
            return A2ACredential.from_dict(cred_data)
        except (json.JSONDecodeError, ValueError, TypeError) as exc:
            logger.warning(
                "[a2a_vault] failed to parse credential for %s: %s",
                agent_id,
                exc,
            )
            return None

    async def set_credential(
        self,
        agent_id: str,
        credential: A2ACredential,
        *,
        pool: Any = None,
    ) -> None:
        """Store or update a credential in the vault.

        In production, operators use the ``eidan secret`` CLI. This method
        is exposed for tests and internal setup.

        Args:
            agent_id: The remote agent's identifier.
            credential: The credential to store.
            pool: Optional asyncpg pool. If provided, the credential is
                  encrypted and written directly to eidan.secrets_vault.
                  Otherwise, raises NotImplementedError (runtime should
                  use the CLI).
        """
        if pool is None:
            raise NotImplementedError(
                "set_credential requires a DB pool. "
                "Use the CLI: `eidan secret set <key> <value>`"
            )

        vault_key = self._vault_key_for_agent(agent_id)
        scope, subkey = vault_key.split(".", 1)
        credential_json = json.dumps(credential.to_dict())

        # Encrypt and write to vault
        try:
            from .auth_native.vault_crypto import encrypt_value

            plaintext = credential_json.encode("utf-8")
            ciphertext = encrypt_value(plaintext)

            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO eidan.secrets_vault (scope, key, value_enc)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (scope, key) DO UPDATE
                    SET value_enc = EXCLUDED.value_enc
                    """,
                    scope,
                    subkey,
                    ciphertext,
                )
            logger.info(
                "[a2a_vault] credential stored for agent %s",
                agent_id,
            )
        except Exception as exc:
            logger.error(
                "[a2a_vault] failed to store credential for %s: %s",
                agent_id,
                exc,
            )
            raise

    async def get_authorization_header(self, agent_id: str) -> str | None:
        """Get the Authorization header value for a remote agent.

        Returns a value ready to use in an ``Authorization: <value>``
        header, or None if credential not found.

        Format depends on auth_method:
        - ``bearer``: ``Bearer <token>``
        - ``api_key``: ``ApiKey <key>``
        """
        credential = await self.get_credential(agent_id)
        if not credential:
            return None

        if credential.auth_method == "bearer":
            return f"Bearer {credential.auth_value}"
        elif credential.auth_method == "api_key":
            return f"ApiKey {credential.auth_value}"

        logger.warning(
            "[a2a_vault] unknown auth_method for %s: %s",
            agent_id,
            credential.auth_method,
        )
        return None


__all__ = [
    "A2ACredential",
    "A2AVaultManager",
]
