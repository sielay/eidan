"""Loop tool-execution tests — `docs/005 §3 ⑥` / `§5.5`.

A turn that scripts:

  scope → sizer → primary (emits tool_use) → primary (emits text)

drives the loop through two primary iterations. The test asserts the
shape the issue's acceptance criteria pin: a registered tool runs, the
``messages.tool_results`` row is written, and there are N
``llm_calls`` rows for N primary iterations.
"""

from __future__ import annotations

import json

import pytest
from eidan_backend.loop import (
    ToolCallArgs,
    ToolCallEnd,
    ToolCallResult,
    ToolCallStart,
    TurnComplete,
    TurnContext,
    run_turn,
)
from eidan_backend.providers.base import AssistantChunk, ToolUseBlock
from eidan_backend.tools import Tool, ToolRegistry

from .conftest import (
    TZ_TEST_KWARGS,
    FakePool,
    FakeProvider,
    FakeStore,
    ScriptedTurn,
    build_identity,
    conversation_uuid,
)


@pytest.mark.asyncio
async def test_tool_loop_executes_registered_tool() -> None:
    captured_args: dict = {}

    async def echo_handler(args: dict) -> str:
        captured_args.update(args)
        return json.dumps({"echoed": args.get("query")})

    registry = ToolRegistry()
    registry.register(
        Tool(
            name="echo",
            description="Echoes the input back.",
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            handler=echo_handler,
        )
    )

    tool_use = ToolUseBlock(
        id="toolu_test_01",
        name="echo",
        input={"query": "hello"},
    )

    provider = FakeProvider(
        [
            # ③ scope classifier — returns one valid skill so parsing succeeds
            ScriptedTurn(text='["coding"]'),
            # ④ sizer — names a valid model so the loop uses it
            ScriptedTurn(text="claude-sonnet-4-6"),
            # ④.5 intent classifier — empty intent list (test focuses on the
            # tool loop, not the action-discipline checks)
            ScriptedTurn(text='{"actions": []}'),
            # ⑥.1 primary — emits a tool_use
            ScriptedTurn(text="thinking", tool_uses=[tool_use]),
            # ⑥.2 primary — final text after seeing the tool result
            ScriptedTurn(text="Here is the answer: hello"),
        ]
    )

    store = FakeStore()
    pool = FakePool(store)
    ctx = TurnContext(identity=build_identity(), conversation_id=conversation_uuid())

    text_chunks: list[str] = []
    completion: TurnComplete | None = None
    async for event in run_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        ctx=ctx,
        user_text="run the tool",
        tool_registry=registry,
        **TZ_TEST_KWARGS,
    ):
        if isinstance(event, TurnComplete):
            completion = event
        elif isinstance(event, AssistantChunk):
            text_chunks.append(event.text)

    assert completion is not None

    # The tool handler actually ran with the model's input.
    assert captured_args == {"query": "hello"}

    # User saw both primary turns' streamed text.
    assert "thinking" in text_chunks
    assert "Here is the answer: hello" in text_chunks

    # One assistant row with role='assistant' and tool_calls populated,
    # one with role='assistant' and no tool_calls (final text).
    assistant_rows = store.messages_by_role("assistant")
    assert len(assistant_rows) == 2

    first_assistant_tool_calls = json.loads(assistant_rows[0][1][5])
    assert first_assistant_tool_calls == [
        {"id": "toolu_test_01", "name": "echo", "input": {"query": "hello"}}
    ]
    second_assistant_tool_calls = json.loads(assistant_rows[1][1][5])
    assert second_assistant_tool_calls == []

    # One tool-role message carrying the result block.
    tool_rows = store.messages_by_role("tool")
    assert len(tool_rows) == 1
    results = json.loads(tool_rows[0][1][4])
    assert results == [
        {
            "tool_use_id": "toolu_test_01",
            "content": json.dumps({"echoed": "hello"}),
            "is_error": False,
        }
    ]

    # Three primary calls? No — two primary, plus scope and sizer.
    # Per the issue's acceptance: N primary iterations → N llm_calls rows
    # with role='primary'.
    llm_rows = store.llm_calls()
    # The role is bound to $4 in the INSERT; we filter by the actual value.
    primary_count = sum(1 for _, args in llm_rows if args[3] == "primary")
    assert primary_count == 2

    scope_count = sum(1 for sql, args in llm_rows if args[3] == "scope_classifier")
    sizer_count = sum(1 for sql, args in llm_rows if args[3] == "sizer")
    assert scope_count == 1
    assert sizer_count == 1

    # Both primary rows are attributed to the user_message_id, not to
    # the assistant message — so a single $1 = user_message_id rollup
    # returns both calls.
    primary_message_ids = [args[2] for sql, args in llm_rows if args[3] == "primary"]
    assert primary_message_ids[0] == primary_message_ids[1]
    assert primary_message_ids[0] == completion.user_message_id

    # The Anthropic-shaped tool surface was passed on the iteration
    # that consumed the registry.
    primary_calls = [c for c in provider.calls if c["tools"] is not None]
    assert len(primary_calls) == 2
    assert primary_calls[0]["tools"] == [
        {
            "name": "echo",
            "description": "Echoes the input back.",
            "input_schema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        }
    ]


@pytest.mark.asyncio
async def test_loop_streams_tool_call_events_in_order() -> None:
    """#265 — the runner surfaces each tool call as an AG-UI-shaped
    quartet in the streamed event sequence: ``ToolCallStart`` →
    ``ToolCallArgs`` (whole JSON) → ``ToolCallEnd`` (the model's
    emission) then ``ToolCallResult`` (after execution). All four share
    the provider's ``tool_use_id``, the start/args/end triple arrives
    before the assistant streams its terminal text, and the result lands
    once the tool has run — all strictly before ``TurnComplete``."""

    async def echo_handler(args: dict) -> str:
        return json.dumps({"echoed": args.get("query")})

    registry = ToolRegistry()
    registry.register(
        Tool(
            name="echo",
            description="Echoes the input back.",
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            handler=echo_handler,
        )
    )

    tool_use = ToolUseBlock(id="toolu_evt_01", name="echo", input={"query": "hello"})
    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="thinking", tool_uses=[tool_use]),
            ScriptedTurn(text="Here is the answer: hello"),
        ]
    )

    store = FakeStore()
    pool = FakePool(store)
    ctx = TurnContext(identity=build_identity(), conversation_id=conversation_uuid())

    events: list = []
    async for event in run_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        ctx=ctx,
        user_text="run the tool",
        tool_registry=registry,
        **TZ_TEST_KWARGS,
    ):
        events.append(event)

    # Exactly one of each tool event for the single dispatched call.
    starts = [e for e in events if isinstance(e, ToolCallStart)]
    args = [e for e in events if isinstance(e, ToolCallArgs)]
    ends = [e for e in events if isinstance(e, ToolCallEnd)]
    results = [e for e in events if isinstance(e, ToolCallResult)]
    assert len(starts) == len(args) == len(ends) == len(results) == 1

    # Shared correlation id across the quartet.
    assert (
        starts[0].tool_call_id
        == args[0].tool_call_id
        == ends[0].tool_call_id
        == results[0].tool_call_id
        == "toolu_evt_01"
    )

    # Payloads carry the model's call + the handler's reply.
    assert starts[0].tool_name == "echo"
    assert json.loads(args[0].args_json) == {"query": "hello"}
    assert json.loads(results[0].content) == {"echoed": "hello"}
    assert results[0].is_error is False

    # Ordering: start → args → end → result, and the whole quartet sits
    # before the terminal TurnComplete.
    kinds = [type(e).__name__ for e in events]
    i_start = kinds.index("ToolCallStart")
    i_args = kinds.index("ToolCallArgs")
    i_end = kinds.index("ToolCallEnd")
    i_result = kinds.index("ToolCallResult")
    i_complete = kinds.index("TurnComplete")
    assert i_start < i_args < i_end < i_result < i_complete

    # The start/args/end triple is the model *emitting* the call, so it
    # precedes the result (which only exists after execution).
    assert i_end < i_result


@pytest.mark.asyncio
async def test_loop_streams_tool_error_as_error_result_event() -> None:
    """#265 — a handler that raises surfaces as a ``ToolCallResult`` with
    ``is_error=True`` in the stream, never an exception out of the
    iterator (mirrors the persisted error block)."""

    async def boom(_: dict) -> str:
        raise RuntimeError("kaboom")

    registry = ToolRegistry()
    registry.register(
        Tool(
            name="boom",
            description="Always fails.",
            input_schema={"type": "object"},
            handler=boom,
        )
    )

    provider = FakeProvider(
        [
            ScriptedTurn(text="[]"),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(
                text="",
                tool_uses=[ToolUseBlock(id="toolu_b", name="boom", input={})],
            ),
            ScriptedTurn(text="I tried, but the tool failed."),
        ]
    )

    store = FakeStore()
    pool = FakePool(store)
    ctx = TurnContext(identity=build_identity(), conversation_id=conversation_uuid())

    results: list[ToolCallResult] = []
    async for event in run_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        ctx=ctx,
        user_text="please run boom",
        tool_registry=registry,
        **TZ_TEST_KWARGS,
    ):
        if isinstance(event, ToolCallResult):
            results.append(event)

    assert len(results) == 1
    assert results[0].tool_call_id == "toolu_b"
    assert results[0].is_error is True
    assert "kaboom" in results[0].content


@pytest.mark.asyncio
async def test_loop_refuses_tool_use_with_empty_registry() -> None:
    """An empty registry never surfaces tools; defensive refusal exits the loop."""

    provider = FakeProvider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-haiku-4-5-20251001"),
            ScriptedTurn(text='{"actions": []}'),
            # The model "should not" emit a tool_use here, but if it
            # does, the loop persists the turn and exits.
            ScriptedTurn(
                text="hi",
                tool_uses=[ToolUseBlock(id="toolu_x", name="ghost", input={})],
            ),
        ]
    )

    store = FakeStore()
    pool = FakePool(store)
    ctx = TurnContext(identity=build_identity(), conversation_id=conversation_uuid())

    async for _ in run_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        ctx=ctx,
        user_text="hi",
        tool_registry=None,  # empty → no `tools=` on the primary call
        **TZ_TEST_KWARGS,
    ):
        pass

    # No tool-role row was written, even though the model emitted tool_use.
    assert store.messages_by_role("tool") == []

    # Exactly one primary llm_call row: we did not loop back after the refused
    # tool_use.
    primary_count = sum(1 for sql, args in store.llm_calls() if args[3] == "primary")
    assert primary_count == 1

    # No tools were passed to any primary call.
    primary_calls = [
        c for c in provider.calls if c["model"] == "claude-haiku-4-5-20251001"
    ]
    for call in primary_calls:
        assert call["tools"] is None


@pytest.mark.asyncio
async def test_tool_error_is_surfaced_as_error_block() -> None:
    """A handler that raises produces an is_error tool_result, not a 500."""

    async def boom(_: dict) -> str:
        raise RuntimeError("kaboom")

    registry = ToolRegistry()
    registry.register(
        Tool(
            name="boom",
            description="Always fails.",
            input_schema={"type": "object"},
            handler=boom,
        )
    )

    provider = FakeProvider(
        [
            ScriptedTurn(text="[]"),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(
                text="",
                tool_uses=[ToolUseBlock(id="toolu_b", name="boom", input={})],
            ),
            ScriptedTurn(text="I tried, but the tool failed."),
        ]
    )

    store = FakeStore()
    pool = FakePool(store)
    ctx = TurnContext(identity=build_identity(), conversation_id=conversation_uuid())

    async for _ in run_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        ctx=ctx,
        user_text="please run boom",
        tool_registry=registry,
        **TZ_TEST_KWARGS,
    ):
        pass

    tool_rows = store.messages_by_role("tool")
    assert len(tool_rows) == 1
    results = json.loads(tool_rows[0][1][4])
    assert len(results) == 1
    assert results[0]["is_error"] is True
    assert "kaboom" in results[0]["content"]


class _RecordingTelemetry:
    """Stand-in for :class:`TelemetryEmitter` that records every emit
    so the loop's `agent.turn.*` beacons (#172) can be asserted."""

    def __init__(self) -> None:
        self.events: list[dict] = []

    async def emit_event(
        self,
        event_type: str,
        payload: dict | None = None,
        *,
        conversation_id=None,
    ) -> None:
        self.events.append(
            {
                "type": event_type,
                "payload": payload or {},
                "conversation_id": conversation_id,
            }
        )


@pytest.mark.asyncio
async def test_loop_emits_turn_lifecycle_events_when_telemetry_supplied() -> None:
    """When the caller passes a telemetry emitter, the loop drops
    `agent.turn.start` + one `agent.turn.tool_call` per dispatched
    tool + `agent.turn.complete` so the live activity tab (#155)
    can show in-flight work. Mirrors the scripted shape from
    `test_tool_loop_executes_registered_tool`."""

    async def echo_handler(args: dict) -> str:
        return json.dumps({"echoed": args.get("query")})

    registry = ToolRegistry()
    registry.register(
        Tool(
            name="echo",
            description="Echoes input back.",
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            handler=echo_handler,
        )
    )

    tool_use = ToolUseBlock(id="toolu_a", name="echo", input={"query": "hi"})
    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="thinking", tool_uses=[tool_use]),
            ScriptedTurn(text="ok"),
        ]
    )

    store = FakeStore()
    pool = FakePool(store)
    ctx = TurnContext(identity=build_identity(), conversation_id=conversation_uuid())
    telemetry = _RecordingTelemetry()

    async for _ in run_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        ctx=ctx,
        user_text="ping",
        tool_registry=registry,
        telemetry=telemetry,  # type: ignore[arg-type]
        agent_name="test-bot",
        **TZ_TEST_KWARGS,
    ):
        pass

    types = [e["type"] for e in telemetry.events]
    assert types.count("agent.turn.start") == 1
    assert types.count("agent.turn.tool_call") == 1
    assert types.count("agent.turn.complete") == 1
    # Order matters — start fires before any tool dispatch, complete
    # fires after every iteration has wound down.
    assert types[0] == "agent.turn.start"
    assert types[-1] == "agent.turn.complete"

    start_event = next(e for e in telemetry.events if e["type"] == "agent.turn.start")
    assert start_event["payload"]["agent_name"] == "test-bot"
    assert start_event["payload"]["user_text_excerpt"] == "ping"
    assert start_event["conversation_id"] == ctx.conversation_id

    tool_event = next(
        e for e in telemetry.events if e["type"] == "agent.turn.tool_call"
    )
    assert tool_event["payload"]["tool_name"] == "echo"
    assert tool_event["payload"]["agent_name"] == "test-bot"
    assert tool_event["conversation_id"] == ctx.conversation_id

    complete_event = next(
        e for e in telemetry.events if e["type"] == "agent.turn.complete"
    )
    assert complete_event["payload"]["agent_name"] == "test-bot"
    assert complete_event["payload"]["tool_uses_seen"] == 1
    assert complete_event["payload"]["iterations"] >= 2  # tool fan-out + terminal


@pytest.mark.asyncio
async def test_loop_skips_turn_events_when_telemetry_is_none() -> None:
    """The default — no telemetry argument — runs cleanly without
    attempting any emit. Keeps the loop usable in REPLs, tests, and
    degraded boots where the telemetry emitter isn't wired."""

    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="hello"),
        ]
    )
    store = FakeStore()
    pool = FakePool(store)
    ctx = TurnContext(identity=build_identity(), conversation_id=conversation_uuid())

    completion: TurnComplete | None = None
    async for event in run_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        ctx=ctx,
        user_text="hi",
        **TZ_TEST_KWARGS,
    ):
        if isinstance(event, TurnComplete):
            completion = event

    assert completion is not None
