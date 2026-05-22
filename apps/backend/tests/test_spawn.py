"""Subagent spawn tests (issue #92 / `docs/008 §3`).

Drives :func:`spawn_turn` through the same FakePool/FakeProvider
fixture the rest of the loop tests use. Covers:

- Happy path: a parent turn writes its anchor, the spawn writes its
  own user / assistant rows under ``depth=1`` with
  ``metadata.parent_message_id`` pointing at the parent.
- Depth cap: a context already at MAX_SPAWN_DEPTH refuses to spawn
  further.
- Failure propagation: a run_turn that raises lands in
  ``SpawnResult.error`` instead of bubbling out, so the parent's
  tool surface can wrap it.
- Cost rollup: the SpawnResult's cost_usd / token counts come from
  the child's anchor user_message_id via cost_summary_for_turn.
"""

from __future__ import annotations

import json
from uuid import UUID

import pytest
from eidan_backend.loop import TurnContext
from eidan_backend.spawn import (
    MAX_SPAWN_DEPTH,
    SpawnRequest,
    SubagentDepthExceeded,
    spawn_turn,
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


def _classifier_pipeline() -> list[ScriptedTurn]:
    """The three classifier calls every turn makes before the primary.

    Returned as a list each test can splice with its own primary
    text — keeps the test bodies focused on the spawn behaviour
    rather than on rehashing scope / sizer / intent shapes.
    """
    return [
        ScriptedTurn(text='["chitchat"]'),  # scope
        ScriptedTurn(text="claude-sonnet-4-6"),  # sizer
        ScriptedTurn(text='{"actions": []}'),  # intent
    ]


@pytest.mark.asyncio
async def test_spawn_turn_happy_path_writes_parent_linkage() -> None:
    """A one-deep spawn writes a user/assistant pair under
    ``depth=1`` and stamps ``metadata.parent_message_id`` on its
    inbound user row pointing at the parent's anchor."""
    provider = FakeProvider(
        _classifier_pipeline()
        + [ScriptedTurn(text="child answer", input_tokens=20, output_tokens=10)]
    )
    store = FakeStore()
    pool = FakePool(store)

    parent_ctx = TurnContext(
        identity=build_identity(),
        conversation_id=conversation_uuid(),
        depth=0,
    )
    parent_anchor = UUID("11111111-1111-1111-1111-111111111111")

    result = await spawn_turn(
        request=SpawnRequest(
            user_text="please summarise the calendar",
            parent=parent_ctx,
            parent_message_id=parent_anchor,
        ),
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        **TZ_TEST_KWARGS,
    )

    assert result.ok is True
    assert result.text == "child answer"
    assert result.depth == 1
    assert result.user_message_id is not None
    assert result.final_message_id is not None

    # The child's user row carries the spawn linkage on metadata.
    user_inserts = [
        args
        for sql, args in store.executes
        if "INSERT INTO eidan.messages" in sql and "'user'" in sql
    ]
    assert len(user_inserts) == 1
    metadata = json.loads(user_inserts[0][4])
    assert metadata["depth"] == 1
    assert metadata["parent_message_id"] == str(parent_anchor)


@pytest.mark.asyncio
async def test_spawn_turn_rolls_up_cost_against_child_anchor() -> None:
    """Every llm_calls row the child wrote attributes to the child's
    own anchor user_message_id; the cost rollup the parent receives
    is the sum across those rows."""
    provider = FakeProvider(
        _classifier_pipeline()
        + [ScriptedTurn(text="ok", input_tokens=100_000, output_tokens=10_000)]
    )
    store = FakeStore()
    pool = FakePool(store)

    parent_ctx = TurnContext(
        identity=build_identity(),
        conversation_id=conversation_uuid(),
    )
    result = await spawn_turn(
        request=SpawnRequest(
            user_text="ping",
            parent=parent_ctx,
            parent_message_id=UUID("22222222-2222-2222-2222-222222222222"),
        ),
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        **TZ_TEST_KWARGS,
    )

    assert result.ok is True
    # Tokens come from the FakeStore aggregation; the spawn's cost
    # has to be > 0 for a turn that wrote ≥ 1 primary row at these
    # token counts (Sonnet pricing).
    assert result.input_tokens >= 100_000
    assert result.output_tokens >= 10_000
    assert result.cost_usd > 0


@pytest.mark.asyncio
async def test_spawn_turn_refuses_at_max_depth() -> None:
    """A parent that's already at MAX_SPAWN_DEPTH may not spawn — the
    raise happens before any provider work."""
    pool = FakePool(FakeStore())
    provider = FakeProvider([])  # never consulted

    parent_at_cap = TurnContext(
        identity=build_identity(),
        conversation_id=conversation_uuid(),
        depth=MAX_SPAWN_DEPTH,
    )
    with pytest.raises(SubagentDepthExceeded):
        await spawn_turn(
            request=SpawnRequest(
                user_text="too deep",
                parent=parent_at_cap,
                parent_message_id=UUID(int=99),
            ),
            pool=pool,  # type: ignore[arg-type]
            provider=provider,  # type: ignore[arg-type]
            model="claude-sonnet-4-6",
            **TZ_TEST_KWARGS,
        )


@pytest.mark.asyncio
async def test_spawn_turn_wraps_child_exception_in_spawn_error() -> None:
    """A child run_turn that raises (e.g. provider script exhausted)
    surfaces as ``ok=False`` with a populated SpawnError, not as a
    bubbling exception. The parent decides whether to route it as a
    tool error."""
    # Script too short — the provider raises AssertionError on the
    # fourth call (primary).
    provider = FakeProvider(_classifier_pipeline())
    store = FakeStore()
    pool = FakePool(store)

    parent_ctx = TurnContext(
        identity=build_identity(),
        conversation_id=conversation_uuid(),
    )
    result = await spawn_turn(
        request=SpawnRequest(
            user_text="will fail",
            parent=parent_ctx,
            parent_message_id=UUID("33333333-3333-3333-3333-333333333333"),
        ),
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        **TZ_TEST_KWARGS,
    )
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "subagent.exception"
    assert "exhausted" in result.error.detail.lower()
