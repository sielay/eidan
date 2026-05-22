"""Budget-cap tests (issue #94 / `docs/010 §2`).

The loop short-circuits before the next provider call when the running
sum of ``llm_calls.cost_usd`` for the anchor user_message_id crosses
the configured per-turn cap. Each scripted provider call writes a row
into the FakeStore; the FakeConnection's ``fetchrow`` aggregates those
rows when the loop asks for the running total, mirroring the production
``cost_summary_for_turn`` query.

The Anthropic pricing table is what produces the per-call cost
(input * input_rate + output * output_rate) inside the loop's
``insert_llm_call`` path — there's no separate cost-injection knob in
``ScriptedTurn``. Tests dial cost by setting ``input_tokens`` /
``output_tokens`` to numbers that, multiplied through the Anthropic
``claude-sonnet-4-6`` rates ($3/$15 per 1M), produce predictable USD
totals.
"""

from __future__ import annotations

import pytest
from eidan_backend.loop import TurnComplete, TurnContext, run_turn
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


def _expensive_turn(text: str = "", tool_uses=None) -> ScriptedTurn:
    """A ScriptedTurn calibrated to cost ~$0.50 against the Sonnet
    rate table ($3/$15 per 1M).

    100_000 input tokens → $0.30; 13_333 output tokens → $0.20.
    Two of these in a row sums to ~$1.00 — straddles the default cap.
    """
    return ScriptedTurn(
        text=text,
        tool_uses=tool_uses or [],
        model="claude-sonnet-4-6",
        input_tokens=100_000,
        output_tokens=13_333,
    )


async def _echo_handler(args: dict) -> str:
    return f"echoed={args.get('q', '')}"


def _registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="echo",
            description="Echo the query.",
            input_schema={
                "type": "object",
                "properties": {"q": {"type": "string"}},
            },
            handler=_echo_handler,
        )
    )
    return registry


@pytest.mark.asyncio
async def test_no_cap_runs_full_tool_loop() -> None:
    """Without ``max_turn_cost_usd`` the loop runs to the model's
    natural stop, even when the cumulative cost would have exceeded a
    cap. Guards against false positives in the cap-on tests below."""
    tool_use = ToolUseBlock(id="t1", name="echo", input={"q": "x"})
    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            _expensive_turn(text="thinking", tool_uses=[tool_use]),
            _expensive_turn(text="done"),
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
        user_text="run the tool",
        tool_registry=_registry(),
        **TZ_TEST_KWARGS,
    ):
        pass

    # Both primary iterations ran.
    primary_count = sum(
        1 for _, args in store.llm_calls() if args[3] == "primary"
    )
    assert primary_count == 2


@pytest.mark.asyncio
async def test_per_turn_cap_short_circuits_loop() -> None:
    """When the running cost crosses the cap after iteration #1, the
    loop refuses to make a second primary call. The test scripts a
    tool-use turn (which would normally drive a second iteration) and
    then asserts only ONE primary row landed."""
    tool_use = ToolUseBlock(id="t1", name="echo", input={"q": "x"})
    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            _expensive_turn(text="will be capped", tool_uses=[tool_use]),
            # The fourth scripted turn would be the second primary — if
            # the budget short-circuit fires, this never gets consumed.
            _expensive_turn(text="should never run"),
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
        user_text="run the tool",
        tool_registry=_registry(),
        max_turn_cost_usd=0.10,  # any first ``_expensive_turn`` exceeds this
        **TZ_TEST_KWARGS,
    ):
        pass

    primary_rows = [
        args for _, args in store.llm_calls() if args[3] == "primary"
    ]
    assert len(primary_rows) == 1, (
        f"expected 1 primary row before budget short-circuit, got "
        f"{len(primary_rows)}"
    )

    # The leftover scripted turn should still be queued — i.e. the
    # provider was never called a second time. 4 total provider calls:
    # scope + sizer + intent + the single expensive primary. The fifth
    # scripted turn (the second primary that would have run if the cap
    # hadn't fired) never gets popped.
    assert len(provider.calls) == 4, (
        f"expected 4 total provider calls, got {len(provider.calls)}"
    )

    # The final assistant message gets a budget_exceeded metadata stamp
    # so the UI debugger can show why we stopped (`docs/010 §2`). The
    # UPDATE binds ``$1=message_id`` and ``$2=metadata_json`` — the
    # payload lives at args[1], not args[0].
    metadata_updates = [
        (sql, args)
        for sql, args in store.executes
        if "UPDATE eidan.messages" in sql and "metadata" in sql
    ]
    assert any(
        "budget_exceeded" in str(args[1])
        for _, args in metadata_updates
    ), "budget_exceeded marker should land on the final assistant row"


@pytest.mark.asyncio
async def test_cap_above_running_total_lets_loop_continue() -> None:
    """The cap is a *threshold*, not a hard ceiling on the first row.
    With a cap above the first iteration's cost the loop continues
    normally."""
    tool_use = ToolUseBlock(id="t1", name="echo", input={"q": "x"})
    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            _expensive_turn(text="step 1", tool_uses=[tool_use]),
            _expensive_turn(text="step 2 final"),
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
        user_text="run the tool",
        tool_registry=_registry(),
        # Cap above the per-iteration cost (~$0.50) but below the
        # cumulative two-iteration cost (~$1.00). The loop short-
        # circuits *after* iteration 2 the same way the no-cap path
        # would end (since iteration 2 emits no tool_use).
        max_turn_cost_usd=10.0,
        **TZ_TEST_KWARGS,
    ):
        if isinstance(event, TurnComplete):
            completion = event
        elif isinstance(event, AssistantChunk):
            pass

    assert completion is not None
    primary_count = sum(
        1 for _, args in store.llm_calls() if args[3] == "primary"
    )
    assert primary_count == 2
