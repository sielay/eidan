"""Secret accessor — `docs/012`.

Replaces the ``_stub_secret`` returning ``None`` for every key. The
accessor a plugin sees on ``ctx.secret`` resolves keys in a fixed
order:

1. **Per-agent override** — when ``current_agent_id`` is set on the
   contextvar (the loop publishes it at the start of every turn),
   the accessor looks up ``agent_context.user_overrides.secrets[<key>]``
   first. This is the per-user-per-agent integration credential
   (e.g. one user's Zoho token vs another's).
2. **Environment variable** — the static tier. Dotted keys map to
   UPPER_SNAKE_CASE env vars (``zoho.access_token`` →
   ``ZOHO_ACCESS_TOKEN``). Already enforced by ``config.py`` for
   host-level settings; this is the per-plugin static fallback.
3. **Native vault** — optional dynamic tier backed by the
   ``eidan.secrets_vault`` table. Values are encrypted at rest with
   ``EIDAN_AUTH_MASTER_KEY``; the multi-instance posture is the
   reason this lives in Postgres rather than on disk. Errors
   degrade to ``None`` rather than raising — the policy is "missing
   key → manifest validation should have caught it, runtime sees
   None and decides what to do."

A plugin manifest's ``vault[]`` block lists every key the plugin
intends to read. The host validates at activation time
(:func:`validate_required_secrets`) that every entry with
``required: true`` resolves through tiers 2 or 3 (per-agent overrides
are NOT enforced at activation, since the agent row may not exist yet
for fresh installs).
"""

from __future__ import annotations

import json
import logging
import os
from typing import TYPE_CHECKING, Any
from uuid import UUID

if TYPE_CHECKING:
    import asyncpg

logger = logging.getLogger(__name__)


def _env_key_for(dotted: str) -> str:
    """``zoho.access_token`` → ``ZOHO_ACCESS_TOKEN``.

    Non-alphanumeric characters collapse to ``_`` so a key like
    ``a-b.c`` maps cleanly to ``A_B_C``.
    """
    upper = dotted.upper()
    return "".join(c if c.isalnum() else "_" for c in upper)


def split_secret_key(key: str) -> tuple[str, str]:
    """Split a dotted secret key into ``(scope, subkey)``.

    ``slack.bot_token`` → ``("slack", "bot_token")``;
    ``plugin_sentry.smtp_password`` → ``("plugin_sentry", "smtp_password")``.
    A key with no ``.`` lands in scope ``core``.

    Single source of truth for vault namespacing: the read path
    (:func:`_read_native_vault`) and the ``eidan secret`` CLI writer
    both call it, so a value set under a key is always found by the
    same key — they cannot drift apart.
    """
    if "." in key:
        scope, _, subkey = key.partition(".")
        return scope, subkey
    return "core", key


async def _read_env(key: str) -> str | None:
    value = os.environ.get(_env_key_for(key))
    return value if value else None


async def _read_native_vault(
    pool: asyncpg.Pool,
    key: str,
) -> str | None:
    """Dynamic-tier lookup against ``eidan.secrets_vault``.

    The key is split on the first ``.`` into ``scope.subkey`` —
    e.g. ``plugin_sentry.smtp_password`` → scope ``plugin_sentry``,
    subkey ``smtp_password``. Keys without a dot land in scope
    ``core``. This mirrors the per-plugin schema convention so a
    plugin's secrets bucket is naturally namespaced.

    Returns ``None`` when the row is missing or when decryption
    fails (the latter is logged so the operator notices a stale
    master-key rotation). The loop never blocks on a vault outage.
    """
    scope, subkey = split_secret_key(key)

    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT value_enc
                FROM eidan.secrets_vault
                WHERE scope = $1 AND key = $2
                """,
                scope,
                subkey,
            )
    except Exception as exc:  # noqa: BLE001 — never block plugin code on DB hiccup
        logger.warning("[secrets] native vault DB lookup failed: %s", exc)
        return None
    if row is None:
        return None

    # Lazy import to avoid pulling cryptography into this module's
    # import graph when the vault is unused.
    try:
        from .auth_native.vault_crypto import decrypt_value
    except Exception as exc:  # noqa: BLE001 — defensive
        logger.warning("[secrets] vault decrypt module import failed: %s", exc)
        return None

    try:
        plaintext = decrypt_value(bytes(row["value_enc"]))
    except Exception as exc:  # noqa: BLE001 — never raise on bad ciphertext
        logger.warning(
            "[secrets] native vault decrypt failed for scope=%s key=%s: %s",
            scope,
            subkey,
            exc,
        )
        return None
    try:
        return plaintext.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning(
            "[secrets] native vault value is not utf-8 for scope=%s key=%s",
            scope,
            subkey,
        )
        return None


async def _read_per_agent_override(
    pool: asyncpg.Pool,
    agent_id: UUID,
    key: str,
) -> str | None:
    """Pull ``user_overrides.secrets[<key>]`` from
    ``eidan.agent_context``.

    Returns ``None`` when the row, the ``secrets`` block, or the key
    itself is absent. Per-agent overrides take precedence over env /
    Vault — operators who provisioned a one-off credential for one
    of their users expect it to win against the host default.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT user_overrides
            FROM eidan.agent_context
            WHERE id = $1
            """,
            agent_id,
        )
    if row is None:
        return None
    overrides = row["user_overrides"]
    if isinstance(overrides, str):
        try:
            overrides = json.loads(overrides)
        except (ValueError, TypeError):
            return None
    if not isinstance(overrides, dict):
        return None
    secrets = overrides.get("secrets")
    if not isinstance(secrets, dict):
        return None
    value = secrets.get(key)
    return value if isinstance(value, str) and value else None


def make_secret_accessor(pool: asyncpg.Pool) -> Any:
    """Build the ``SecretAccessor`` the bootstrap hands to every
    plugin context (`docs/012`).

    Returns a coroutine ``(key: str) -> str | None`` that walks the
    three tiers in order. The pool is captured by closure so the
    per-agent override path has a connection to read from; the
    ``current_agent_id`` contextvar (set by the loop at turn start
    via :mod:`eidan_backend.identity`) tells the accessor whose
    overrides to consult.
    """
    # Local import to avoid a circular dep at module-import time.
    from .identity import get_current_agent_id

    async def _secret(key: str) -> str | None:
        agent_id = get_current_agent_id()
        if agent_id is not None:
            override = await _read_per_agent_override(pool, agent_id, key)
            if override is not None:
                return override

        env_value = await _read_env(key)
        if env_value is not None:
            return env_value

        return await _read_native_vault(pool, key)

    return _secret


class MissingRequiredSecret(Exception):
    """A plugin's required ``vault[]`` key could not be resolved."""


async def validate_required_secrets(
    secret: Any,
    *,
    plugin_name: str,
    declared: list[Any],
) -> None:
    """Check that every ``required: true`` entry in the plugin's
    manifest ``vault[]`` block resolves through env / Vault tiers.

    Per-agent overrides are not consulted here — they live under a
    user that may not exist yet at activation. The runtime path
    (when the loop calls the plugin's handler) does consult them.

    Raises :class:`MissingRequiredSecret` listing every unresolved
    required key. Empty / optional declarations are no-ops.
    """
    missing: list[str] = []
    for item in declared:
        required = bool(getattr(item, "required", False))
        if not required:
            continue
        key = getattr(item, "key", None)
        if not isinstance(key, str) or not key:
            continue
        # Bypass the per-agent tier by temporarily zeroing the
        # contextvar — activation runs before the loop publishes an
        # agent. Cheap, and avoids requiring the accessor to expose a
        # "skip overrides" variant.
        from .identity import current_agent_id

        token = current_agent_id.set(None)
        try:
            value = await secret(key)
        finally:
            current_agent_id.reset(token)
        if value is None:
            missing.append(key)

    if missing:
        raise MissingRequiredSecret(
            f"plugin {plugin_name!r} cannot activate: required vault "
            f"key(s) not resolved through env or the native vault "
            f"(eidan.secrets_vault): {', '.join(missing)}"
        )


__all__ = [
    "MissingRequiredSecret",
    "make_secret_accessor",
    "validate_required_secrets",
]
