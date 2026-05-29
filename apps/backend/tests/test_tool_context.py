"""ToolContext dispatch + plugin-emitted llm_calls — issue #16.

Two surfaces:

- The registry's arity-aware dispatch — a one-arg handler stays
  one-arg; a two-arg handler receives a :class:`ToolContext`.
- The loop's wiring — a plugin tool that calls
  ``ctx.report_llm_call(...)`` lands an ``eidan.llm_calls`` row
  anchored to the calling turn's user_message_id, with
  ``role='plugin_tool'`` and ``cost_usd`` computed by the host's
  price table. The next per-turn rollup includes it (`docs/010
  §4` / §8.1 unified ledger).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import pytest
from eidan_backend.loop import TurnComplete, TurnContext, run_turn
from eidan_backend.providers.base import AssistantChunk, ToolUseBlock
from eidan_backend.tools import (
    Tool,
    ToolContext,
    ToolRegistry,
    _handler_accepts_context,
)

from .conftest import (
    TZ_TEST_KWARGS,
    FakePool,
    FakeProvider,
    FakeStore,
    ScriptedTurn,
    build_identity,
    conversation_uuid,
)

# ── unit: arity detection ────────────────────────────────────────────


def test_single_arg_handler_does_not_accept_context() -> None:
    async def one_arg(args: dict) -> str:
        return ""

    assert _handler_accepts_context(one_arg) is False


def test_two_arg_handler_accepts_context() -> None:
    async def two_arg(args: dict, ctx: ToolContext) -> str:
        return ""

    assert _handler_accepts_context(two_arg) is True


def test_var_args_handler_accepts_context() -> None:
    async def star_args(*args) -> str:  # type: ignore[no-untyped-def]
        return ""

    assert _handler_accepts_context(star_args) is True


def test_tool_post_init_records_accepts_context_flag() -> None:
    async def one_arg(args: dict) -> str:
        return ""

    async def two_arg(args: dict, ctx: ToolContext) -> str:
        return ""

    t1 = Tool(name="one", description="", input_schema={}, handler=one_arg)
    t2 = Tool(name="two", description="", input_schema={}, handler=two_arg)
    assert t1.accepts_context is False
    assert t2.accepts_context is True


# ── unit: registry dispatch ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_registry_dispatches_single_arg_handler_without_ctx() -> None:
    captured: dict = {}

    async def echo(args: dict) -> str:
        captured.update(args)
        return "ok"

    registry = ToolRegistry()
    registry.register(
        Tool(name="echo", description="", input_schema={}, handler=echo)
    )
    fake_ctx = _build_dummy_tool_context()
    out = await registry.execute("echo", {"x": 1}, fake_ctx)
    assert out == "ok"
    assert captured == {"x": 1}


@pytest.mark.asyncio
async def test_registry_passes_ctx_to_two_arg_handler() -> None:
    seen_ctx: list[ToolContext] = []

    async def handler(args: dict, ctx: ToolContext) -> str:
        seen_ctx.append(ctx)
        return "ok"

    registry = ToolRegistry()
    registry.register(
        Tool(name="t", description="", input_schema={}, handler=handler)
    )
    fake_ctx = _build_dummy_tool_context()
    await registry.execute("t", {}, fake_ctx)
    assert len(seen_ctx) == 1
    assert seen_ctx[0] is fake_ctx


@pytest.mark.asyncio
async def test_two_arg_handler_without_ctx_falls_back_to_single_call() -> None:
    """Defensive: a registry caller that omits ``ctx`` does not crash
    a two-arg handler; the registry simply invokes it single-arg.
    The handler decides whether to error or degrade."""
    invocations: list[int] = []

    async def handler(args: dict) -> str:  # noqa: ARG001 — fake one-arg adapter
        invocations.append(1)
        return ""

    registry = ToolRegistry()
    registry.register(
        Tool(name="t", description="", input_schema={}, handler=handler)
    )
    # No ctx provided — handler still runs.
    await registry.execute("t", {}, None)
    assert invocations == [1]


# ── integration: loop + report_llm_call ─────────────────────────────


@pytest.mark.asyncio
async def test_tool_handler_can_emit_llm_call_via_report() -> None:
    """A plugin tool invoking ``ctx.report_llm_call`` lands an
    ``eidan.llm_calls`` row that:
      - carries the calling turn's user_message_id,
      - is tagged ``role='plugin_tool'`` by default,
      - has ``cost_usd`` computed by the host's price table.

    The next per-turn rollup (the FakePool's canned aggregate) sums
    it alongside the primary rows.
    """
    reported: dict[str, object] = {}

    async def call_vendor(args: dict, ctx: ToolContext) -> str:
        # Pretend we shelled out to a vendor CLI and parsed its
        # stream-JSON. Report the spend through the host.
        started = datetime.now(UTC)
        await ctx.report_llm_call(
            provider="vendor-cli",
            model="claude-opus-4-7",  # priced via host price table
            role="plugin_tool",
            input_tokens=1_000,
            output_tokens=2_000,
            cache_read_tokens=500,
            cache_creation_tokens=0,
            started_at=started,
            finished_at=datetime.now(UTC),
            request_id="vendor-req-1",
            metadata={"upstream": "cli"},
        )
        reported["called"] = True
        reported["message_id"] = ctx.message_id
        reported["agent_id"] = ctx.agent_id
        return "ok"

    registry = ToolRegistry()
    registry.register(
        Tool(
            name="vendor",
            description="",
            input_schema={
                "type": "object",
                "properties": {"q": {"type": "string"}},
            },
            handler=call_vendor,
        )
    )

    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),  # scope
            ScriptedTurn(text="claude-sonnet-4-6"),  # sizer
            ScriptedTurn(text='{"actions": []}'),  # intent
            # primary 1 — emits a tool_use for the plugin tool
            ScriptedTurn(
                text="working",
                tool_uses=[
                    ToolUseBlock(id="toolu_v", name="vendor", input={"q": "ping"})
                ],
            ),
            # primary 2 — final text
            ScriptedTurn(text="done"),
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
        user_text="please",
        tool_registry=registry,
        **TZ_TEST_KWARGS,
    ):
        if isinstance(event, TurnComplete):
            completion = event
        elif isinstance(event, AssistantChunk):
            pass

    assert completion is not None
    assert reported.get("called") is True
    # ToolContext.message_id is the turn anchor — the inbound user
    # message id, which the loop yielded back in `TurnComplete`.
    assert reported["message_id"] == completion.user_message_id

    # The plugin row landed in `eidan.llm_calls` with role='plugin_tool'.
    llm_rows = store.llm_calls()
    plugin_rows = [args for _sql, args in llm_rows if args[3] == "plugin_tool"]
    assert len(plugin_rows) == 1
    plugin_args = plugin_rows[0]
    # Anchors: user_id, conversation_id, message_id inherited.
    assert plugin_args[0] == UUID(build_identity().user_id)
    assert plugin_args[1] == conversation_uuid()
    assert plugin_args[2] == completion.user_message_id
    # Provider + model the plugin passed.
    assert plugin_args[4] == "vendor-cli"
    assert plugin_args[5] == "claude-opus-4-7"
    # The four token axes.
    assert plugin_args[6] == 1_000  # input_tokens
    assert plugin_args[7] == 2_000  # output_tokens
    assert plugin_args[8] == 500    # cache_read_tokens
    assert plugin_args[9] == 0      # cache_creation_tokens
    # cost_usd computed by host: opus = $15 in / $75 out / $1.50 cache_read
    # per Mtok. 1_000 * 15 / 1e6 + 2_000 * 75 / 1e6 + 500 * 1.5 / 1e6
    # = 0.015 + 0.150 + 0.00075 = 0.16575
    assert plugin_args[10] == pytest.approx(0.16575)

    # The agent_id stamped on the plugin row matches the turn's
    # agent_context, NOT None.
    assert plugin_args[15] is not None


@pytest.mark.asyncio
async def test_failed_plugin_call_still_writes_a_row() -> None:
    """`docs/010 §2.1`: failed calls still land in the ledger so the
    operator pays the same scrutiny to provider-side errors. A plugin
    that wraps a vendor call that failed mid-stream reports a row
    with ``error_type`` set and whatever tokens the upstream charged
    for."""

    async def vendor_fail(args: dict, ctx: ToolContext) -> str:
        await ctx.report_llm_call(
            provider="vendor-cli",
            model="claude-sonnet-4-6",
            role="plugin_tool",
            input_tokens=200,
            output_tokens=0,  # stream aborted before any output
            started_at=datetime.now(UTC),
            error="connection reset by peer",
            error_type="VendorStreamError",
            metadata={"attempt": 1},
        )
        return "vendor failed"

    registry = ToolRegistry()
    registry.register(
        Tool(
            name="vendor",
            description="",
            input_schema={"type": "object"},
            handler=vendor_fail,
        )
    )

    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(
                text="trying",
                tool_uses=[ToolUseBlock(id="toolu_f", name="vendor", input={})],
            ),
            ScriptedTurn(text="recovered"),
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
        user_text="please",
        tool_registry=registry,
        **TZ_TEST_KWARGS,
    ):
        pass

    # Plugin row landed despite the error — the writer never swallows it.
    plugin_rows = [args for _sql, args in store.llm_calls() if args[3] == "plugin_tool"]
    assert len(plugin_rows) == 1
    plugin_args = plugin_rows[0]
    # insert_plugin_llm_call args: ... cost_usd[10] latency_ms[11]
    # started_at[12] finished_at[13] request_id[14] agent_id[15]
    # error[16] error_type[17] metadata[18]
    assert plugin_args[16] == "connection reset by peer"
    assert plugin_args[17] == "VendorStreamError"


# ── helpers ─────────────────────────────────────────────────────────


def _build_dummy_tool_context() -> ToolContext:
    """Build a no-op :class:`ToolContext` for registry unit tests."""

    async def _noop_writer(**_kwargs: object) -> None:
        return None

    return ToolContext(
        user_id=UUID("00000000-0000-0000-0000-000000000001"),
        conversation_id=UUID("00000000-0000-0000-0000-000000000002"),
        message_id=UUID("00000000-0000-0000-0000-000000000003"),
        agent_id=None,
        report_llm_call=_noop_writer,
    )
