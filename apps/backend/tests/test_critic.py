"""Loop critic-path tests — `docs/005 §3 ⑦ ⑧` / `§5.7 §5.8`.

Acceptance criteria from the issue:

- A turn that triggers an obvious refusal pattern produces a critic
  ``llm_calls`` row.
- A turn that does not trigger the detector skips the critic call
  entirely (no extra ``llm_calls`` row).
"""

from __future__ import annotations

import pytest
from eidan_backend.loop import TurnComplete, TurnContext, run_turn

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
async def test_refusal_triggers_critic_call() -> None:
    """A refusal-prefixed primary response convenes the critic."""
    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            # Intent classifier — refusal scenario has no actionable intent.
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="I cannot help with that request."),
            # Critic verdict — JSON object per the prompt.
            ScriptedTurn(text='{"verdict": "rewrite", "reason": "primary refused without cause"}'),
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
        user_text="explain how to do the thing",
        **TZ_TEST_KWARGS,
    ):
        if isinstance(event, TurnComplete):
            completion = event

    assert completion is not None

    llm_rows = store.llm_calls()
    critic_rows = [(sql, args) for sql, args in llm_rows if args[3] == "critic"]
    assert len(critic_rows) == 1

    # The critic's llm_calls row attributes to its own (new) assistant
    # message, distinct from the user message that the primary calls
    # attribute to.
    critic_message_id = critic_rows[0][1][2]
    primary_rows = [args for sql, args in llm_rows if args[3] == "primary"]
    assert primary_rows
    assert critic_message_id != primary_rows[0][2]

    # The primary assistant message's metadata was updated with the
    # critic verdict. The UPDATE targets the *final* assistant_message_id
    # the loop returned. The loop also stamps ``completed_at`` on the
    # same row at TurnComplete; filter the verdict update out of the
    # two-update sequence by payload.
    update_executes = [
        (sql, args) for sql, args in store.executes
        if "UPDATE eidan.messages" in sql
    ]
    critic_updates = [
        (sql, args) for sql, args in update_executes
        if "critic" in args[1]
    ]
    assert len(critic_updates) == 1
    update_args = critic_updates[0][1]
    assert update_args[0] == completion.assistant_message_id
    assert "rewrite" in update_args[1]


@pytest.mark.asyncio
async def test_normal_response_skips_critic() -> None:
    """A response that doesn't match any detector signal pays no critic cost."""
    provider = FakeProvider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-haiku-4-5-20251001"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="The answer is 42. Let me know if you want more."),
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
        user_text="what is the answer to life",
        **TZ_TEST_KWARGS,
    ):
        pass

    llm_rows = store.llm_calls()
    critic_rows = [(sql, args) for sql, args in llm_rows if args[3] == "critic"]
    assert critic_rows == []

    # No critic provider call should have happened — only scope, sizer,
    # intent, primary (4 calls total since #59 added the intent classifier).
    assert len(provider.calls) == 4

    # No critic-flavoured metadata UPDATE. The loop still stamps
    # ``completed_at`` at TurnComplete; that one is expected.
    update_executes = [
        (sql, args) for sql, args in store.executes
        if "UPDATE eidan.messages" in sql
    ]
    critic_updates = [
        (sql, args) for sql, args in update_executes
        if "critic" in args[1] or "verdict" in args[1]
    ]
    assert critic_updates == []


@pytest.mark.asyncio
async def test_empty_response_triggers_critic() -> None:
    """Empty final assistant text fires the detector too."""
    provider = FakeProvider(
        [
            ScriptedTurn(text='["coding"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text=""),
            ScriptedTurn(text='{"verdict": "rewrite", "reason": "empty answer"}'),
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
        user_text="please answer",
        **TZ_TEST_KWARGS,
    ):
        pass

    llm_rows = store.llm_calls()
    critic_count = sum(1 for sql, args in llm_rows if args[3] == "critic")
    assert critic_count == 1
