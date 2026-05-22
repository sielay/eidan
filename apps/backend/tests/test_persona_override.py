"""Persona resolution precedence in the agent loop (`docs/005 §5.2`).

Verifies the three-layer composition the loop performs for every primary
call's system prompt:

    [TZ header]
    [EIDAN_BASE_IDENTITY]       — hardcoded, always rendered
    [action list]
    [effective persona]         — ctx.system_prompt OR agent_persona OR None

Order of precedence — top wins:

    1. ``TurnContext.system_prompt`` (caller-supplied; how a plugin /
       sub-agent overrides for one turn).
    2. ``agent_context.user_overrides.system_prompt`` (the operator's
       saved persona for their default agent).
    3. ``agent_context.code_defaults.system_prompt`` (the
       code-shipped default; today empty for the default agent).
    4. None — only EIDAN_BASE_IDENTITY renders.
"""

from __future__ import annotations

import pytest
from eidan_backend.loop import TurnContext, run_turn
from eidan_backend.turn_header import EIDAN_BASE_IDENTITY

from .conftest import (
    TZ_TEST_KWARGS,
    FakePool,
    FakeStore,
    ScriptedTurn,
    build_identity,
    conversation_uuid,
)


def _baseline_script() -> list[ScriptedTurn]:
    """Scope → sizer → intent → primary — the minimum for one terminal turn."""
    return [
        ScriptedTurn(text='["chitchat"]'),
        ScriptedTurn(text="claude-sonnet-4-6"),
        ScriptedTurn(text='{"actions": []}'),
        ScriptedTurn(text="ack."),
    ]


async def _drive_turn(provider, store: FakeStore, *, ctx: TurnContext) -> None:
    pool = FakePool(store)
    async for _ in run_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,
        model="claude-sonnet-4-6",
        ctx=ctx,
        user_text="hi",
        **TZ_TEST_KWARGS,
    ):
        pass


def _primary_system(provider) -> str:
    """The system prompt the primary call (4th provider call) saw."""
    assert len(provider.calls) >= 4, provider.calls
    system = provider.calls[3]["system"]
    assert isinstance(system, str)
    return system


@pytest.mark.asyncio
async def test_baseline_identity_always_renders(stub_provider) -> None:
    """With no persona anywhere, only EIDAN_BASE_IDENTITY renders after
    the TZ header."""
    provider = stub_provider(_baseline_script())
    store = FakeStore()  # default empty user_overrides + code_defaults
    ctx = TurnContext(
        identity=build_identity(), conversation_id=conversation_uuid()
    )

    await _drive_turn(provider, store, ctx=ctx)

    system = _primary_system(provider)
    assert EIDAN_BASE_IDENTITY in system


@pytest.mark.asyncio
async def test_agent_context_persona_renders_when_ctx_unset(
    stub_provider,
) -> None:
    """user_overrides.system_prompt rides on top of EIDAN_BASE_IDENTITY
    when the caller didn't supply a per-turn override."""
    provider = stub_provider(_baseline_script())
    store = FakeStore(
        default_user_overrides={"system_prompt": "You speak only in haiku."}
    )
    ctx = TurnContext(
        identity=build_identity(), conversation_id=conversation_uuid()
    )

    await _drive_turn(provider, store, ctx=ctx)

    system = _primary_system(provider)
    assert EIDAN_BASE_IDENTITY in system
    assert "You speak only in haiku." in system


@pytest.mark.asyncio
async def test_code_default_persona_renders_when_user_override_empty(
    stub_provider,
) -> None:
    """code_defaults.system_prompt is the fallback when user_overrides
    has no system_prompt — the contract that makes "ship a sub-agent
    with a default persona" honest."""
    provider = stub_provider(_baseline_script())
    store = FakeStore(
        default_code_defaults={"system_prompt": "Default sub-agent persona."},
    )
    ctx = TurnContext(
        identity=build_identity(), conversation_id=conversation_uuid()
    )

    await _drive_turn(provider, store, ctx=ctx)

    system = _primary_system(provider)
    assert "Default sub-agent persona." in system


@pytest.mark.asyncio
async def test_ctx_system_prompt_overrides_agent_context_persona(
    stub_provider,
) -> None:
    """Plugin / sub-agent path: a caller-supplied ``ctx.system_prompt``
    replaces the operator's agent_context persona entirely for that turn.

    The baseline identity still renders — neither the operator nor a
    plugin can erase "I'm Eidan, not Claude". A sub-agent can only
    shift the persona layer that sits on top.
    """
    provider = stub_provider(_baseline_script())
    store = FakeStore(
        default_user_overrides={"system_prompt": "operator's persona"},
    )
    ctx = TurnContext(
        identity=build_identity(),
        conversation_id=conversation_uuid(),
        system_prompt="plugin sub-agent persona",
    )

    await _drive_turn(provider, store, ctx=ctx)

    system = _primary_system(provider)
    assert EIDAN_BASE_IDENTITY in system
    assert "plugin sub-agent persona" in system
    # The operator's persona is suppressed for this turn — the plugin's
    # caller-supplied prompt won.
    assert "operator's persona" not in system


@pytest.mark.asyncio
async def test_user_override_beats_code_default(stub_provider) -> None:
    """When both layers carry system_prompt, user_overrides wins —
    mirrors the persistence helper's resolution chain."""
    provider = stub_provider(_baseline_script())
    store = FakeStore(
        default_code_defaults={"system_prompt": "code default — should lose"},
        default_user_overrides={"system_prompt": "operator override — should win"},
    )
    ctx = TurnContext(
        identity=build_identity(), conversation_id=conversation_uuid()
    )

    await _drive_turn(provider, store, ctx=ctx)

    system = _primary_system(provider)
    assert "operator override — should win" in system
    assert "code default — should lose" not in system
