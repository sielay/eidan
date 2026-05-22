"""Vault accessor tests (issue #96 / `docs/012`).

The host's secret accessor walks three tiers in order: per-agent
override → env var → Supabase Vault. This file exercises tiers 1 and 2
directly with a hand-rolled pool fake; the Supabase Vault tier is a
real HTTP call gated on ``SUPABASE_VAULT_URL`` and not exercised here.

``validate_required_secrets`` is the activation-time check the
bootstrap runs against each plugin's ``vault[]`` declarations.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from eidan_backend.identity import current_agent_id
from eidan_backend.secrets import (
    MissingRequiredSecret,
    _env_key_for,
    make_secret_accessor,
    validate_required_secrets,
)

# ---- pool / connection fakes --------------------------------------------


class _FakeConnection:
    def __init__(self, overrides_by_agent: dict[UUID, dict]) -> None:
        self._overrides = overrides_by_agent

    async def fetchrow(self, sql: str, *args: Any) -> dict | None:
        agent_id = args[0]
        overrides = self._overrides.get(agent_id)
        if overrides is None:
            return None
        return {"user_overrides": json.dumps(overrides)}


class _AcquireCtx:
    def __init__(self, conn: _FakeConnection) -> None:
        self._conn = conn

    async def __aenter__(self) -> _FakeConnection:
        return self._conn

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _FakePool:
    def __init__(self, overrides_by_agent: dict[UUID, dict]) -> None:
        self._overrides = overrides_by_agent

    def acquire(self) -> _AcquireCtx:
        return _AcquireCtx(_FakeConnection(self._overrides))


# ---- env-var tier --------------------------------------------------------


def test_env_key_mapping() -> None:
    assert _env_key_for("zoho.access_token") == "ZOHO_ACCESS_TOKEN"
    assert _env_key_for("a-b.c") == "A_B_C"
    assert _env_key_for("plain") == "PLAIN"


@pytest.mark.asyncio
async def test_env_tier_resolves_when_no_agent_in_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ZOHO_ACCESS_TOKEN", "from-env")
    pool = _FakePool(overrides_by_agent={})
    secret = make_secret_accessor(pool)  # type: ignore[arg-type]
    value = await secret("zoho.access_token")
    assert value == "from-env"


@pytest.mark.asyncio
async def test_env_tier_returns_none_for_missing_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ZOHO_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("SUPABASE_VAULT_URL", raising=False)
    pool = _FakePool(overrides_by_agent={})
    secret = make_secret_accessor(pool)  # type: ignore[arg-type]
    assert await secret("zoho.access_token") is None


# ---- per-agent tier ------------------------------------------------------


@pytest.mark.asyncio
async def test_per_agent_override_wins_over_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Operators who provision per-user credentials expect those to
    beat the host-wide env-var default."""
    monkeypatch.setenv("ZOHO_ACCESS_TOKEN", "from-env")
    agent_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1")
    pool = _FakePool(
        overrides_by_agent={
            agent_id: {"secrets": {"zoho.access_token": "from-agent"}}
        }
    )
    secret = make_secret_accessor(pool)  # type: ignore[arg-type]

    token = current_agent_id.set(agent_id)
    try:
        value = await secret("zoho.access_token")
    finally:
        current_agent_id.reset(token)
    assert value == "from-agent"


@pytest.mark.asyncio
async def test_per_agent_override_absent_falls_through_to_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OTHER_KEY", "from-env")
    agent_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2")
    pool = _FakePool(
        overrides_by_agent={agent_id: {"secrets": {"some.other.key": "x"}}}
    )
    secret = make_secret_accessor(pool)  # type: ignore[arg-type]
    token = current_agent_id.set(agent_id)
    try:
        value = await secret("other.key")
    finally:
        current_agent_id.reset(token)
    assert value == "from-env"


@pytest.mark.asyncio
async def test_per_agent_override_missing_row_is_silent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("NO_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_VAULT_URL", raising=False)
    pool = _FakePool(overrides_by_agent={})
    secret = make_secret_accessor(pool)  # type: ignore[arg-type]
    token = current_agent_id.set(UUID(int=42))
    try:
        assert await secret("no.key") is None
    finally:
        current_agent_id.reset(token)


# ---- activation-time validation -----------------------------------------


@dataclass
class _DeclaredItem:
    key: str
    required: bool = False


@pytest.mark.asyncio
async def test_validate_required_secrets_passes_when_env_satisfies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    pool = _FakePool(overrides_by_agent={})
    secret = make_secret_accessor(pool)  # type: ignore[arg-type]
    await validate_required_secrets(
        secret,
        plugin_name="stripe-fulfilment",
        declared=[
            _DeclaredItem(key="stripe.secret_key", required=True),
            _DeclaredItem(key="stripe.optional", required=False),
        ],
    )


@pytest.mark.asyncio
async def test_validate_required_secrets_raises_for_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_VAULT_URL", raising=False)
    pool = _FakePool(overrides_by_agent={})
    secret = make_secret_accessor(pool)  # type: ignore[arg-type]
    with pytest.raises(MissingRequiredSecret) as exc:
        await validate_required_secrets(
            secret,
            plugin_name="stripe-fulfilment",
            declared=[_DeclaredItem(key="stripe.secret_key", required=True)],
        )
    assert "stripe-fulfilment" in str(exc.value)
    assert "stripe.secret_key" in str(exc.value)


@pytest.mark.asyncio
async def test_validate_skips_per_agent_tier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Activation runs before the loop publishes an agent_id. The
    per-agent tier must be bypassed, so a key that exists ONLY as a
    per-agent override should fail validation."""
    monkeypatch.delenv("INTEGRATION_TOKEN", raising=False)
    monkeypatch.delenv("SUPABASE_VAULT_URL", raising=False)
    agent_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3")
    pool = _FakePool(
        overrides_by_agent={
            agent_id: {"secrets": {"integration.token": "from-agent-only"}}
        }
    )
    secret = make_secret_accessor(pool)  # type: ignore[arg-type]

    # Even with the contextvar set ahead of time, validate must skip
    # the per-agent tier and report the missing key.
    token = current_agent_id.set(agent_id)
    try:
        with pytest.raises(MissingRequiredSecret):
            await validate_required_secrets(
                secret,
                plugin_name="integration",
                declared=[
                    _DeclaredItem(key="integration.token", required=True)
                ],
            )
    finally:
        current_agent_id.reset(token)
