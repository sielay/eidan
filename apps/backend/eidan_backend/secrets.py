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
    except Exception:  # noqa: BLE001 — never raise on bad ciphertext
        # Static message: scope/key/exc all derive from the lookup key, which
        # CodeQL taints as sensitive (clear-text logging). The signal — a vault
        # value won't decrypt, usually a stale master key — needs no identifier.
        logger.warning("[secrets] a vault value failed to decrypt (stale master key?)")
        return None
    try:
        return plaintext.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning("[secrets] a vault value is not valid utf-8")
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


async def _audit(
    conn: Any, *, user_id: Any, scope: str, key: str, action: str, actor: str | None
) -> None:
    """Append a row to ``eidan.secrets_audit`` (`docs/012` §8).

    Best-effort — an audit failure must never sink the operation it
    records, so callers wrap this in their own try/except where the
    write itself already committed.
    """
    await conn.execute(
        """
        INSERT INTO eidan.secrets_audit (user_id, scope, key, action, actor)
        VALUES ($1, $2, $3, $4, $5)
        """,
        user_id,
        scope,
        key,
        action,
        actor,
    )


async def _audit_safe(
    conn: Any, *, user_id: Any, scope: str, key: str, action: str, actor: str | None
) -> None:
    """Best-effort :func:`_audit`. An audit-insert failure must never surface
    to the caller whose write / delete / read has already happened."""
    try:
        await _audit(
            conn, user_id=user_id, scope=scope, key=key, action=action, actor=actor
        )
    except Exception as exc:  # noqa: BLE001 — audit is best-effort
        logger.warning("[secrets] audit insert failed (action=%s): %s", action, exc)


async def write(
    pool: asyncpg.Pool,
    key: str,
    value: str,
    *,
    user_id: Any | None = None,
    ttl_seconds: int | None = None,
    actor: str | None = None,
) -> None:
    """Encrypt ``value`` and upsert it into the native vault (`docs/012` §5.2).

    ``user_id=None`` is an instance/system secret (the historic behaviour);
    a non-null ``user_id`` is that user's own credential — the per-user
    dimension docs/031 adds. Fernet output is non-deterministic, so two
    writes of the same plaintext differ. ``ttl_seconds`` sets ``expires_at``;
    ``None`` means no expiry.
    """
    from .auth_native.vault_crypto import encrypt_value  # lazy: see _read_native_vault

    scope, subkey = split_secret_key(key)
    ciphertext = encrypt_value(value.encode("utf-8"))
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO eidan.secrets_vault (user_id, scope, key, value_enc, expires_at)
            VALUES (
                $1, $2, $3, $4,
                CASE WHEN $5::bigint IS NULL THEN NULL
                     ELSE now() + make_interval(secs => $5) END
            )
            ON CONFLICT (user_id, scope, key) DO UPDATE
            SET value_enc = EXCLUDED.value_enc,
                expires_at = EXCLUDED.expires_at,
                updated_at = now()
            """,
            user_id,
            scope,
            subkey,
            ciphertext,
            ttl_seconds,
        )
        await _audit_safe(
            conn, user_id=user_id, scope=scope, key=subkey, action="write", actor=actor
        )


async def delete(
    pool: asyncpg.Pool,
    key: str,
    *,
    user_id: Any | None = None,
    actor: str | None = None,
) -> None:
    """Idempotent hard delete of a vault row (`docs/012` §5.3).

    ``user_id IS NOT DISTINCT FROM $1`` so a ``None`` (instance) row and a
    per-user row are addressed unambiguously. A missing row is a no-op.
    """
    scope, subkey = split_secret_key(key)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            DELETE FROM eidan.secrets_vault
            WHERE user_id IS NOT DISTINCT FROM $1 AND scope = $2 AND key = $3
            """,
            user_id,
            scope,
            subkey,
        )
        await _audit_safe(
            conn, user_id=user_id, scope=scope, key=subkey, action="delete", actor=actor
        )


async def read(
    pool: asyncpg.Pool, key: str, *, user_id: Any | None = None
) -> str | None:
    """Read + decrypt a single vault value for ``(user_id, scope, key)``.

    Honours ``expires_at`` (a row past its TTL reads as ``None``; the sweep
    deletes it later). This is the *vault-tier* read with an explicit user
    — distinct from the tiered accessor (:func:`make_secret_accessor`),
    which the agentic loop uses to resolve a key across override/env/vault.
    """
    scope, subkey = split_secret_key(key)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT value_enc FROM eidan.secrets_vault
                WHERE user_id IS NOT DISTINCT FROM $1 AND scope = $2 AND key = $3
                  AND (expires_at IS NULL OR expires_at > now())
                """,
                user_id,
                scope,
                subkey,
            )
            await _audit_safe(
                conn, user_id=user_id, scope=scope, key=subkey, action="read", actor=None
            )
    except Exception as exc:  # noqa: BLE001 — never block a read on a DB hiccup
        logger.warning("[secrets] vault read DB lookup failed: %s", exc)
        return None
    if row is None:
        return None
    try:
        from .auth_native.vault_crypto import decrypt_value

        return decrypt_value(bytes(row["value_enc"])).decode("utf-8")
    except Exception:  # noqa: BLE001 — never raise on bad ciphertext
        # Static message — the key name, scope, and exception are all derived
        # from the lookup key, which CodeQL treats as sensitive (clear-text
        # logging). The signal that matters (a vault value won't decrypt,
        # usually a stale/rotated master key) needs no identifier.
        logger.warning("[secrets] a vault value failed to decrypt (stale master key?)")
        return None


def user_provided_keys(plugins: Any) -> set[str]:
    """The dotted vault keys declared ``user_provided`` across the loaded
    plugins (docs/031). The self-serve secrets API writes only keys in this
    set, so a caller can't stash arbitrary values in the vault.
    """
    keys: set[str] = set()
    for loaded in plugins or []:
        manifest = getattr(loaded, "manifest", None)
        for item in getattr(manifest, "vault", None) or []:
            if bool(getattr(item, "user_provided", False)):
                k = getattr(item, "key", None)
                if isinstance(k, str) and k:
                    keys.add(k)
    return keys


async def list_user_secrets(
    pool: asyncpg.Pool, *, user_id: Any
) -> list[dict[str, Any]]:
    """Metadata for one user's vault entries — dotted key + expiry, **never
    the value** (`docs/012` §6.2: the self-serve API is write-only).
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT scope, key, expires_at, updated_at
            FROM eidan.secrets_vault
            WHERE user_id = $1
            ORDER BY scope, key
            """,
            user_id,
        )
    out: list[dict[str, Any]] = []
    for r in rows:
        scope, subkey = r["scope"], r["key"]
        name = subkey if scope == "core" else f"{scope}.{subkey}"
        out.append(
            {
                "key": name,
                "expires_at": r["expires_at"],
                "updated_at": r["updated_at"],
            }
        )
    return out


def _current_user_id() -> Any | None:
    """The acting user's id from the turn's identity, or ``None`` (host work)."""
    from .identity import get_current_identity

    ident = get_current_identity()
    if ident is None or not getattr(ident, "user_id", None):
        return None
    try:
        return UUID(str(ident.user_id))
    except (ValueError, TypeError):  # pragma: no cover — defensive
        return None


class _SecretAccessor:
    """Concrete ``SecretAccessor`` (`docs/012` §5–6) handed to every plugin.

    Callable for the tiered read (override → env → vault); ``write`` /
    ``delete`` mutate the native vault scoped to the **current user** (or
    instance scope outside a turn). The pool is captured so all three
    paths share the host connection pool.
    """

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def __call__(self, key: str) -> str | None:
        # Local import to avoid a circular dep at module-import time.
        from .identity import get_current_agent_id

        agent_id = get_current_agent_id()
        if agent_id is not None:
            override = await _read_per_agent_override(self._pool, agent_id, key)
            if override is not None:
                return override

        env_value = await _read_env(key)
        if env_value is not None:
            return env_value

        return await _read_native_vault(self._pool, key)

    async def write(self, key: str, value: str, *, ttl_seconds: int | None = None) -> None:
        await write(
            self._pool, key, value,
            user_id=_current_user_id(), ttl_seconds=ttl_seconds, actor="ctx",
        )

    async def delete(self, key: str) -> None:
        await delete(self._pool, key, user_id=_current_user_id(), actor="ctx")


def make_secret_accessor(pool: asyncpg.Pool) -> Any:
    """Build the ``SecretAccessor`` the bootstrap hands to every plugin
    context (`docs/012`).

    Returns a :class:`_SecretAccessor` — callable ``(key) -> str | None``
    for the three-tier read (per-agent override → env → vault, the
    ``current_agent_id`` contextvar selecting whose overrides apply), plus
    ``write`` / ``delete`` that mutate the native vault for the current user.
    """
    return _SecretAccessor(pool)


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

    ``user_provided`` entries are skipped (docs/031): the end user
    supplies them per-user via the self-serve secrets API at runtime, so
    they cannot resolve at activation even when marked ``required``.

    Raises :class:`MissingRequiredSecret` listing every unresolved
    required key. Empty / optional declarations are no-ops.
    """
    missing: list[str] = []
    for item in declared:
        required = bool(getattr(item, "required", False))
        if not required or bool(getattr(item, "user_provided", False)):
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
    "delete",
    "list_user_secrets",
    "make_secret_accessor",
    "read",
    "user_provided_keys",
    "validate_required_secrets",
    "write",
]
