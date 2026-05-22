"""Loop tests for the retry-once branch (issue #60 follow-up).

When the says-vs-did signal fires AND the critic returns ``rewrite``,
the loop opens one more primary iteration with a tightened wrap-up
addendum. If that iteration emits tool_uses, the loop executes them
and runs one terminal iteration for final text. Anything else (other
verdicts, other signals, no signals) keeps the existing Phase-1.5
"record-but-don't-act" behaviour intact.

These tests script the provider so we can exercise the retry path
without touching Anthropic.
"""

from __future__ import annotations

import json

import pytest
from eidan_backend.loop import TurnComplete, TurnContext, run_turn
from eidan_backend.providers.base import ToolUseBlock
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

_CREATE_EVENT_INTENT = json.dumps(
    {
        "actions": [
            {
                "kind": "create_event",
                "when": "2026-05-15T19:00:00+01:00",
                "summary": "dentist",
            }
        ]
    }
)


def _count_primary_llm_calls(store: FakeStore) -> int:
    """Count rows the loop wrote with ``role = 'primary'``."""
    return sum(
        1 for _sql, args in store.llm_calls() if args[3] == "primary"
    )


def _retry_message_metadata(store: FakeStore) -> list[dict]:
    """Return parsed ``metadata`` dicts for every assistant INSERT whose
    metadata carries a ``retry`` marker."""
    out: list[dict] = []
    for sql, args in store.executes:
        if "INTO eidan.messages" not in sql or "'assistant'" not in sql:
            continue
        # insert_assistant_message's args are (id, user_id, conv, parent,
        # content, tool_calls_json, provider, model, metadata_json, agent_id).
        # agent_id is appended at the end so existing positional asserts
        # (this one + the role-at-args[3] checks in test_critic, test_tool_loop)
        # stay stable.
        metadata_json = args[8]
        try:
            metadata = json.loads(metadata_json)
        except (TypeError, ValueError):
            continue
        if isinstance(metadata, dict) and "retry" in metadata:
            out.append(metadata)
    return out


@pytest.mark.asyncio
async def test_retry_fires_when_says_vs_did_and_rewrite() -> None:
    """Verifiable intent + zero tool_uses + rewrite verdict opens the retry.

    The retry's first call here still emits no tool — the test asserts
    the retry happened (one extra `primary` row + a retry-tagged
    assistant message) but doesn't require the agent to succeed. A
    persistent says-vs-did is a real outcome the operator may see; the
    bounded retry is "try once" not "guarantee success".
    """
    provider = FakeProvider(
        [
            ScriptedTurn(text='["planning"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text=_CREATE_EVENT_INTENT),
            # Primary 1 — says done, no tool. Triggers actions_declared_not_executed.
            ScriptedTurn(text="Done — I added the dentist event to your calendar."),
            # Critic verdict — request a rewrite.
            ScriptedTurn(
                text='{"verdict": "rewrite", "reason": "no tool_use emitted"}'
            ),
            # Retry primary — still no tool, but the retry path itself is what we care about.
            ScriptedTurn(text="Apologies — calendar tool unavailable."),
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
        user_text="book dentist tomorrow 19:00",
        **TZ_TEST_KWARGS,
    ):
        if isinstance(event, TurnComplete):
            completion = event

    assert completion is not None

    assert _count_primary_llm_calls(store) == 2, (
        "expected the original primary call + one retry primary call"
    )

    retries = _retry_message_metadata(store)
    assert len(retries) == 1
    assert retries[0]["retry"] == "actions_declared_not_executed"


@pytest.mark.asyncio
async def test_retry_with_tool_use_runs_two_iterations() -> None:
    """Retry's first call emits tool_use → loop runs ONE terminal call.

    Asserts the full retry path: original primary → critic → retry
    primary (tool_use) → terminal primary (text). Three primary calls.
    """
    registry = ToolRegistry()
    captured: list[dict] = []

    async def calendar_handler(payload: dict) -> str:
        captured.append(payload)
        return "event_created:tx_42"

    registry.register(
        Tool(
            name="calendar_add",
            description="Create a calendar event.",
            input_schema={"type": "object"},
            handler=calendar_handler,
        )
    )

    provider = FakeProvider(
        [
            ScriptedTurn(text='["planning"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text=_CREATE_EVENT_INTENT),
            # Primary 1 — says done, no tool.
            ScriptedTurn(text="Done — calendar entry added."),
            # Critic — rewrite.
            ScriptedTurn(
                text='{"verdict": "rewrite", "reason": "no tool call"}'
            ),
            # Retry primary — emits the tool_use this time.
            ScriptedTurn(
                text="On it.",
                tool_uses=[
                    ToolUseBlock(
                        id="toolu_a",
                        name="calendar_add",
                        input={
                            "when": "2026-05-15T19:00:00+01:00",
                            "summary": "dentist",
                        },
                    )
                ],
            ),
            # Terminal primary — text after seeing tool_result.
            ScriptedTurn(text="OK — the dentist event is on your calendar."),
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
        user_text="book dentist tomorrow 19:00",
        tool_registry=registry,
        **TZ_TEST_KWARGS,
    ):
        pass

    assert captured == [
        {
            "when": "2026-05-15T19:00:00+01:00",
            "summary": "dentist",
        }
    ], "the tool handler should have run during the retry"

    assert _count_primary_llm_calls(store) == 3, (
        "expected original + retry-with-tool + terminal primary calls"
    )

    retry_kinds = {m["retry"] for m in _retry_message_metadata(store)}
    assert retry_kinds == {
        "actions_declared_not_executed",
        "actions_declared_not_executed_terminal",
    }


@pytest.mark.asyncio
async def test_no_retry_when_verdict_accept() -> None:
    """Says-vs-did fires, critic returns ``accept`` → no retry runs."""
    provider = FakeProvider(
        [
            ScriptedTurn(text='["planning"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text=_CREATE_EVENT_INTENT),
            ScriptedTurn(text="Done — added it."),
            ScriptedTurn(
                text='{"verdict": "accept", "reason": "false positive"}'
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
        user_text="book dentist tomorrow 19:00",
        **TZ_TEST_KWARGS,
    ):
        pass

    assert _count_primary_llm_calls(store) == 1, (
        "accept verdict must NOT open a retry"
    )
    assert _retry_message_metadata(store) == []


@pytest.mark.asyncio
async def test_no_retry_when_only_other_signals_fire() -> None:
    """Retry is scoped to actions_declared_not_executed.

    A rewrite verdict on, say, ``refusal`` does NOT open a retry —
    that's Phase 2 behaviour. Phase 1.5's only rewrite-acting branch
    is the says-vs-did one.
    """
    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),  # no intended actions
            ScriptedTurn(text="I cannot help with that."),
            ScriptedTurn(
                text='{"verdict": "rewrite", "reason": "refusal without cause"}'
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
        user_text="explain this",
        **TZ_TEST_KWARGS,
    ):
        pass

    assert _count_primary_llm_calls(store) == 1, (
        "rewrite on a non-says-vs-did signal must NOT open a retry"
    )
