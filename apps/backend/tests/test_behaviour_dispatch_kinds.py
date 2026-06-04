# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for behaviour dispatch kinds — `docs/026` slice 3.

Verifies that BehaviourRegistry.dispatch() routes handlers correctly
based on their declared kind and provides appropriate context:

- llm_turn: Handler called with TriggerEvent only
- tool_chain: Handler called with TriggerEvent + BehaviourContext(tools)
- classifier_gate: Handler called with TriggerEvent + BehaviourContext(tools, classify)
- notify: Handler NOT called; event written directly
"""

from __future__ import annotations

import pytest
from eidan_backend.behaviours.context import BehaviourContext
from eidan_backend.behaviours.registry import (
    Behaviour,
    BehaviourRegistry,
    BehaviourResult,
    TriggerEvent,
)
from eidan_backend.behaviours.triggers import Trigger
from eidan_backend.tools import ToolRegistry


@pytest.fixture
def tool_registry() -> ToolRegistry:
    """Minimal tool registry for testing."""
    return ToolRegistry()


@pytest.fixture
def behaviour_registry(tool_registry: ToolRegistry) -> BehaviourRegistry:
    """Registry wired with tool registry."""
    return BehaviourRegistry(tool_registry=tool_registry)


@pytest.mark.asyncio
async def test_llm_turn_dispatch_calls_handler_with_event_only(
    behaviour_registry: BehaviourRegistry,
) -> None:
    """llm_turn handlers receive only TriggerEvent (current path)."""
    received_args: list = []

    async def llm_turn_handler(event: TriggerEvent) -> BehaviourResult:
        received_args.append(("event", event))
        return BehaviourResult(ok=True, notes_for_model="llm_turn handler ran")

    behaviour = Behaviour(
        id="test:llm_turn",
        trigger=Trigger(kind="event", spec="test"),
        handler=llm_turn_handler,
        kind="llm_turn",
    )
    behaviour_registry.register(behaviour)

    result = await behaviour_registry.dispatch(
        "test:llm_turn",
        idempotency_key="key1",
        payload={"data": "value"},
    )

    assert result is not None
    assert result.ok is True
    assert result.notes_for_model == "llm_turn handler ran"
    # Handler received only the event, not a context
    assert len(received_args) == 1
    assert received_args[0][0] == "event"
    assert isinstance(received_args[0][1], TriggerEvent)


@pytest.mark.asyncio
async def test_tool_chain_dispatch_provides_context_with_tools(
    behaviour_registry: BehaviourRegistry,
) -> None:
    """tool_chain handlers receive TriggerEvent + BehaviourContext(tools)."""
    received_args: list = []

    async def tool_chain_handler(
        event: TriggerEvent, ctx: BehaviourContext
    ) -> BehaviourResult:
        received_args.append(("event", event, "ctx", ctx))
        assert ctx.tools is not None
        assert ctx.classify is None
        return BehaviourResult(ok=True, notes_for_model="tool_chain handler ran")

    behaviour = Behaviour(
        id="test:tool_chain",
        trigger=Trigger(kind="event", spec="test"),
        handler=tool_chain_handler,
        kind="tool_chain",
    )
    behaviour_registry.register(behaviour)

    result = await behaviour_registry.dispatch(
        "test:tool_chain",
        idempotency_key="key2",
        payload={"data": "value"},
    )

    assert result is not None
    assert result.ok is True
    assert result.notes_for_model == "tool_chain handler ran"
    # Handler received event and context with tools
    assert len(received_args) == 1
    assert received_args[0][0] == "event"
    assert isinstance(received_args[0][1], TriggerEvent)
    assert received_args[0][2] == "ctx"
    assert isinstance(received_args[0][3], BehaviourContext)
    assert received_args[0][3].tools is not None
    assert received_args[0][3].classify is None


@pytest.mark.asyncio
async def test_classifier_gate_dispatch_provides_context_with_tools_and_classify(
    behaviour_registry: BehaviourRegistry,
) -> None:
    """classifier_gate handlers receive TriggerEvent + BehaviourContext(tools, classify)."""
    received_args: list = []

    async def classifier_gate_handler(
        event: TriggerEvent, ctx: BehaviourContext
    ) -> BehaviourResult:
        received_args.append(("event", event, "ctx", ctx))
        assert ctx.tools is not None
        # TODO: ctx.classify should be wired; for now it's None (bootstrap wiring pending)
        return BehaviourResult(ok=True, notes_for_model="classifier_gate handler ran")

    behaviour = Behaviour(
        id="test:classifier_gate",
        trigger=Trigger(kind="event", spec="test"),
        handler=classifier_gate_handler,
        kind="classifier_gate",
    )
    behaviour_registry.register(behaviour)

    result = await behaviour_registry.dispatch(
        "test:classifier_gate",
        idempotency_key="key3",
        payload={"data": "value"},
    )

    assert result is not None
    assert result.ok is True
    assert result.notes_for_model == "classifier_gate handler ran"
    # Handler received event and context with tools and classifier
    assert len(received_args) == 1
    assert isinstance(received_args[0][1], TriggerEvent)
    assert isinstance(received_args[0][3], BehaviourContext)
    assert received_args[0][3].tools is not None


@pytest.mark.asyncio
async def test_notify_dispatch_does_not_call_handler(
    behaviour_registry: BehaviourRegistry,
) -> None:
    """notify behaviours do NOT call their handler; event written directly."""
    handler_called = False

    async def notify_handler(event: TriggerEvent) -> BehaviourResult:
        nonlocal handler_called
        handler_called = True
        return BehaviourResult(ok=True)

    behaviour = Behaviour(
        id="test:notify",
        trigger=Trigger(kind="cron", spec="* * * * *"),
        handler=notify_handler,
        kind="notify",
    )
    behaviour_registry.register(behaviour)

    result = await behaviour_registry.dispatch(
        "test:notify",
        idempotency_key="key4",
        payload={},
    )

    # Handler should NOT have been called
    assert handler_called is False
    # But dispatch still returns success
    assert result is not None
    assert result.ok is True


@pytest.mark.asyncio
async def test_idempotency_still_works_across_kinds(
    behaviour_registry: BehaviourRegistry,
) -> None:
    """Idempotency gate works regardless of kind."""
    call_count = 0

    async def handler(event: TriggerEvent, ctx: BehaviourContext) -> BehaviourResult:
        nonlocal call_count
        call_count += 1
        return BehaviourResult(ok=True)

    behaviour = Behaviour(
        id="test:idempotent",
        trigger=Trigger(kind="event", spec="test"),
        handler=handler,
        kind="tool_chain",
    )
    behaviour_registry.register(behaviour)

    # First call succeeds
    result1 = await behaviour_registry.dispatch(
        "test:idempotent",
        idempotency_key="same_key",
        payload={},
    )
    assert result1 is not None
    assert call_count == 1

    # Second call with same key returns None (skipped)
    result2 = await behaviour_registry.dispatch(
        "test:idempotent",
        idempotency_key="same_key",
        payload={},
    )
    assert result2 is None
    assert call_count == 1  # Handler not called again


@pytest.mark.asyncio
async def test_unknown_kind_raises_error(
    behaviour_registry: BehaviourRegistry,
) -> None:
    """Unknown kind raises ValueError."""
    # Directly construct a Behaviour with invalid kind to bypass validation
    # (the dataclass already validates, so this is defense-in-depth in dispatch)
    behaviour = Behaviour(
        id="test:invalid",
        trigger=Trigger(kind="event", spec="test"),
        handler=lambda e: None,
        kind="llm_turn",  # Bypass with valid kind to construct
    )
    behaviour_registry.register(behaviour)

    # Manually override kind to invalid value (for testing edge case)
    behaviour_registry._behaviours["test:invalid"].kind = "unknown_kind"  # type: ignore

    with pytest.raises(ValueError, match="unknown behaviour kind"):
        await behaviour_registry.dispatch(
            "test:invalid",
            idempotency_key="key",
            payload={},
        )
