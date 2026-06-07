"""Unit + integration tests for the ``learn`` core plugin (issue #50).

Three surfaces under test:

- pure helpers in ``research`` (snippet, tsquery, suggested_questions),
- the survey functions assembled against a fake asyncpg connection,
- the plugin's ``on_activate`` registers the tool, and the tool's
  handler returns the assembled survey JSON.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

# Make the plugin importable in tests — it lives outside the workspace
# member packages because plugins are dropped in at install time.
_PLUGIN_PATH = Path(__file__).resolve().parents[3] / "plugins" / "learn"
sys.path.insert(0, str(_PLUGIN_PATH))

from eidan_backend.identity import Identity, current_identity  # noqa: E402
from eidan_backend.plugins import PluginContext  # noqa: E402
from eidan_backend.tools import Tool, ToolError  # noqa: E402
from eidan_learn.plugin import Plugin  # type: ignore[import-not-found]  # noqa: E402
from eidan_learn.research import (  # type: ignore[import-not-found]  # noqa: E402
    KnowledgeHit,
    MessageHit,
    NoteHit,
    _snippet,
    _suggested_questions,
    _topic_like_pattern,
    _topic_to_tsquery,
    run_survey,
)


def _user_id() -> UUID:
    return UUID("00000000-0000-0000-0000-000000000001")


# -----------------------------------------------------------------------------
# Pure-helper tests
# -----------------------------------------------------------------------------


def test_snippet_returns_empty_string_on_none() -> None:
    assert _snippet(None) == ""


def test_snippet_flattens_whitespace_and_truncates_long_text() -> None:
    text = "a\n\nb  c\td" + ("x" * 400)
    out = _snippet(text, length=20)
    assert "\n" not in out
    assert "\t" not in out
    assert len(out) == 20
    assert out.endswith("…")


def test_topic_to_tsquery_handles_empty_topic() -> None:
    assert _topic_to_tsquery("") == ""
    assert _topic_to_tsquery("   ") == ""


def test_topic_to_tsquery_joins_tokens_with_and() -> None:
    assert _topic_to_tsquery("rust async runtime") == "rust:* & async:* & runtime:*"


def test_topic_to_tsquery_strips_single_quotes() -> None:
    """Belt-and-braces: even though asyncpg parameterises, we strip the
    quote so the resulting query string isn't malformed if logged."""
    assert _topic_to_tsquery("o'reilly") == "o:* & reilly:*"


def test_topic_like_pattern_wraps_with_percent() -> None:
    assert _topic_like_pattern("rust async") == "%rust async%"


def test_suggested_questions_when_no_signal() -> None:
    qs = _suggested_questions("widgets", [], [], [])
    assert len(qs) == 3
    assert any("'widgets'" in q for q in qs)


def test_suggested_questions_when_some_signal() -> None:
    qs = _suggested_questions(
        "widgets",
        [KnowledgeHit(id="x", skill="widgets", title="t", snippet="s")],
        [],
        [],
    )
    assert len(qs) == 2


def test_suggested_questions_when_lots_of_signal() -> None:
    qs = _suggested_questions(
        "widgets",
        [
            KnowledgeHit(id="x", skill="widgets", title="t", snippet="s"),
            KnowledgeHit(id="y", skill="widgets", title="t", snippet="s"),
        ],
        [NoteHit(id="n", conversation_id=None, snippet="s")],
        [MessageHit(conversation_id="c", role="user", snippet="s")],
    )
    assert len(qs) == 2
    assert any("prior material" in q for q in qs)


# -----------------------------------------------------------------------------
# Survey integration against a fake connection
# -----------------------------------------------------------------------------


@dataclass
class _FakeConn:
    """Records SQL + args, returns canned rows keyed on SQL substring."""

    canned: dict[str, list[dict]] = field(default_factory=dict)
    calls: list[tuple[str, tuple]] = field(default_factory=list)

    async def fetch(self, sql: str, *args: Any) -> list[dict]:
        self.calls.append((sql, args))
        for needle, rows in self.canned.items():
            if needle in sql:
                return rows
        return []


@pytest.mark.asyncio
async def test_run_survey_combines_three_sources() -> None:
    conn = _FakeConn(
        canned={
            "FROM eidan.knowledge": [
                {
                    "id": UUID("11111111-1111-1111-1111-111111111111"),
                    "skill": "rust",
                    "title": "Async basics",
                    "body": "Rust async uses futures and a runtime.",
                }
            ],
            "FROM eidan.notes": [
                {
                    "id": UUID("22222222-2222-2222-2222-222222222222"),
                    "conversation_id": UUID(
                        "33333333-3333-3333-3333-333333333333"
                    ),
                    "content": "Looked at rust async vs threads — runtime matters.",
                }
            ],
            "FROM eidan.messages": [
                {
                    "conversation_id": UUID(
                        "44444444-4444-4444-4444-444444444444"
                    ),
                    "role": "user",
                    "content": "I'm comparing tokio and async-std",
                }
            ],
        }
    )

    survey = await run_survey(conn, user_id=_user_id(), topic="rust async")

    assert len(survey.knowledge) == 1
    assert survey.knowledge[0].title == "Async basics"
    assert len(survey.notes) == 1
    assert survey.notes[0].conversation_id == "33333333-3333-3333-3333-333333333333"
    assert len(survey.messages) == 1
    assert survey.messages[0].role == "user"
    assert len(survey.suggested_questions) == 2  # "some signal" branch


@pytest.mark.asyncio
async def test_run_survey_returns_empty_for_blank_topic() -> None:
    conn = _FakeConn(canned={"FROM eidan.knowledge": []})
    survey = await run_survey(conn, user_id=_user_id(), topic="")
    # Empty topic short-circuits tsquery, so knowledge survey is empty.
    assert survey.knowledge == []
    # Notes / messages still run with an empty pattern; canned returns nothing.
    assert survey.notes == []
    assert survey.messages == []


@pytest.mark.asyncio
async def test_survey_to_json_is_well_formed() -> None:
    conn = _FakeConn(canned={})
    survey = await run_survey(conn, user_id=_user_id(), topic="topic")

    payload = json.loads(survey.to_json())
    assert payload["topic"] == "topic"
    assert payload["knowledge"] == []
    assert payload["notes"] == []
    assert payload["messages"] == []
    assert "summary" in payload
    assert isinstance(payload["suggested_questions"], list)


# -----------------------------------------------------------------------------
# Plugin contract — on_activate registers the tool; handler returns survey
# -----------------------------------------------------------------------------


class _StubDb:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    def acquire(self) -> Any:
        conn = self._conn

        class _Cm:
            async def __aenter__(self) -> _FakeConn:
                return conn

            async def __aexit__(self, *_args: Any) -> None:
                pass

        return _Cm()


async def _stub_secret(_key: str) -> str | None:
    return None


@dataclass
class _ToolCapture:
    tools: list[Tool] = field(default_factory=list)

    def __call__(self, tools: Iterable[Tool]) -> None:
        self.tools.extend(tools)


def _identity(user_id: str = "00000000-0000-0000-0000-000000000001") -> Identity:
    return Identity(
        user_id=user_id,
        email=f"{user_id}@example.test",
        session_id=None,
        aal="aal1",
        raw_claims={},
    )


def _build_ctx(conn: _FakeConn) -> tuple[PluginContext, _ToolCapture]:
    capture = _ToolCapture()
    ctx = PluginContext(
        name="learn",
        db=_StubDb(conn),
        secret=_stub_secret,
        register_router=lambda _r: None,
        register_behaviours=lambda _b: None,
        register_tools=capture,
        identity=None,  # plugins don't need identity at activation
    )
    return ctx, capture


@pytest.mark.asyncio
async def test_plugin_registers_learn_tool_on_activate() -> None:
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())

    await plugin.on_activate(ctx)

    assert len(capture.tools) == 1
    tool = capture.tools[0]
    assert tool.name == "learn"
    assert "topic" in tool.input_schema["required"]


@pytest.mark.asyncio
async def test_tool_handler_reads_identity_from_contextvar() -> None:
    """Identity is ambient: the loop sets it before invoking the tool.

    The test sets ``current_identity`` directly to mimic what the loop
    does at the top of ``run_turn``.
    """
    conn = _FakeConn(
        canned={
            "FROM eidan.knowledge": [
                {
                    "id": UUID("11111111-1111-1111-1111-111111111111"),
                    "skill": "rust",
                    "title": "Async basics",
                    "body": "futures + runtime",
                }
            ],
        }
    )
    plugin = Plugin()
    ctx, capture = _build_ctx(conn)
    await plugin.on_activate(ctx)
    tool = capture.tools[0]

    current_identity.set(_identity())
    payload = await tool.handler({"topic": "rust async"})

    parsed = json.loads(payload)
    assert parsed["topic"] == "rust async"
    assert len(parsed["knowledge"]) == 1
    assert parsed["knowledge"][0]["title"] == "Async basics"


@pytest.mark.asyncio
async def test_tool_refuses_before_activation() -> None:
    """Calling the handler before on_activate raises ToolError rather
    than producing a confusing empty result."""
    plugin = Plugin()
    current_identity.set(_identity())
    with pytest.raises(ToolError):
        await plugin._handle_learn({"topic": "anything"})


@pytest.mark.asyncio
async def test_tool_refuses_without_identity_in_contextvar() -> None:
    """No ambient identity → tool refuses. Mirrors what the agent loop
    guarantees: identity is set before any tool runs."""
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())
    await plugin.on_activate(ctx)
    tool = capture.tools[0]

    current_identity.set(None)
    with pytest.raises(ToolError, match="identity"):
        await tool.handler({"topic": "anything"})


@pytest.mark.asyncio
async def test_tool_refuses_empty_topic() -> None:
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())
    await plugin.on_activate(ctx)
    tool = capture.tools[0]

    current_identity.set(_identity())
    with pytest.raises(ToolError):
        await tool.handler({"topic": "   "})
