"""Unit tests for the intent classifier (issue #59 piece B).

Two surfaces under test:

- ``classify_intent`` — parses the classifier's JSON output, collapses
  malformed input to a single ``Unknown`` entry so the loop always
  makes forward progress.
- ``render_action_list`` — pure renderer the loop calls to append the
  action list to the primary's system prompt.
"""

from __future__ import annotations

import pytest
from eidan_backend.classifiers import classify_intent, render_action_list
from eidan_backend.classifiers.scope import ScopeResult
from eidan_schemas import (
    CreateEvent,
    IntendedActions,
    Lookup,
    SendMessage,
    Unknown,
    UpdateRow,
)

from .conftest import FakeProvider, ScriptedTurn


@pytest.mark.asyncio
async def test_parses_a_well_formed_intent_list() -> None:
    provider = FakeProvider(
        [
            ScriptedTurn(
                text=(
                    '{"actions": ['
                    '{"kind": "create_event", "when": "2026-05-15T19:00:00+01:00",'
                    ' "summary": "dentist"},'
                    '{"kind": "lookup", "query": "what time is dentist"}'
                    ']}'
                )
            )
        ]
    )

    result, _call = await classify_intent(
        provider=provider,
        user_text="book dentist tomorrow 19:00 and tell me when",
        scope=ScopeResult(skills=["planning"]),
    )

    actions = result.intended.actions
    assert len(actions) == 2
    assert isinstance(actions[0], CreateEvent)
    assert actions[0].summary == "dentist"
    assert isinstance(actions[1], Lookup)
    assert actions[1].query == "what time is dentist"


@pytest.mark.asyncio
async def test_collapses_invalid_json_to_one_unknown() -> None:
    provider = FakeProvider([ScriptedTurn(text="not json at all")])

    result, _call = await classify_intent(
        provider=provider,
        user_text="whatever",
        scope=ScopeResult(skills=[]),
    )

    assert len(result.intended.actions) == 1
    only = result.intended.actions[0]
    assert isinstance(only, Unknown)
    assert "invalid JSON" in only.note


@pytest.mark.asyncio
async def test_collapses_unknown_kinds_per_entry() -> None:
    """An out-of-catalogue ``kind`` does not poison the whole list."""
    provider = FakeProvider(
        [
            ScriptedTurn(
                text=(
                    '{"actions": ['
                    '{"kind": "future_kind", "fields": {"foo": "bar"}},'
                    '{"kind": "lookup", "query": "the weather"}'
                    ']}'
                )
            )
        ]
    )

    result, _call = await classify_intent(
        provider=provider,
        user_text="something",
        scope=ScopeResult(skills=[]),
    )

    actions = result.intended.actions
    assert len(actions) == 2
    assert isinstance(actions[0], Unknown)
    assert "future_kind" in actions[0].note
    assert isinstance(actions[1], Lookup)


@pytest.mark.asyncio
async def test_handles_missing_actions_field() -> None:
    provider = FakeProvider([ScriptedTurn(text='{"other": "field"}')])

    result, _call = await classify_intent(
        provider=provider,
        user_text="ignored",
        scope=ScopeResult(skills=[]),
    )

    assert len(result.intended.actions) == 1
    assert isinstance(result.intended.actions[0], Unknown)


@pytest.mark.asyncio
async def test_empty_actions_list_is_valid() -> None:
    """Pure-chitchat turns produce no actions; the loop's primary call
    falls back to ``ctx.system_prompt`` alone."""
    provider = FakeProvider([ScriptedTurn(text='{"actions": []}')])

    result, _call = await classify_intent(
        provider=provider,
        user_text="hi",
        scope=ScopeResult(skills=["chitchat"]),
    )

    assert result.intended.actions == []


def test_render_empty_list_returns_empty_string() -> None:
    rendered = render_action_list(IntendedActions(actions=[]))
    assert rendered == ""


def test_render_single_create_event() -> None:
    rendered = render_action_list(
        IntendedActions(
            actions=[
                CreateEvent(
                    kind="create_event",
                    when="2026-05-15T19:00:00+01:00",
                    summary="dentist",
                )
            ]
        )
    )
    assert "create_event when=2026-05-15T19:00:00+01:00" in rendered
    assert "summary='dentist'" in rendered
    assert "in order" in rendered
    assert rendered.endswith("\n")


def test_render_mixed_list_renders_each_kind() -> None:
    rendered = render_action_list(
        IntendedActions(
            actions=[
                CreateEvent(
                    kind="create_event", when="now", summary="standup"
                ),
                UpdateRow(
                    kind="update_row",
                    table="eidan.user_context",
                    key={"id": "abc"},
                    fields={"value": "new"},
                ),
                SendMessage(
                    kind="send_message",
                    channel="email",
                    recipient="a@b.com",
                    body="hi",
                ),
                Lookup(kind="lookup", query="what's up"),
                Unknown(kind="unknown", note="ambiguous"),
            ]
        )
    )
    # All five kinds appear in the rendered block; the numbered prefix
    # is per-action so the rendered text contains "1." through "5.".
    for n in range(1, 6):
        assert f"  {n}." in rendered
    assert "create_event" in rendered
    assert "update_row" in rendered
    assert "send_message" in rendered
    assert "lookup: what's up" in rendered
    assert "ambiguous" in rendered
