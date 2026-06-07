"""Tests for the ``capture`` core plugin (remember / note / event)."""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

_PLUGIN_PATH = Path(__file__).resolve().parents[3] / "plugins" / "capture"
sys.path.insert(0, str(_PLUGIN_PATH))

from eidan_backend.identity import (  # noqa: E402
    Identity,
    current_agent_id,
    current_identity,
)
from eidan_backend.plugins import PluginContext  # noqa: E402
from eidan_backend.tools import Tool, ToolError  # noqa: E402
from eidan_capture.plugin import Plugin  # type: ignore[import-not-found]  # noqa: E402


def _identity(user_id: str = "00000000-0000-0000-0000-000000000001") -> Identity:
    return Identity(
        user_id=user_id,
        email=f"{user_id}@example.test",
        session_id=None,
        aal="aal1",
        raw_claims={},
    )


@dataclass
class _FakeConn:
    """Records SQL + args; returns canned fetchrow values keyed on SQL substring."""

    canned_fetchrow: dict[str, dict] = field(default_factory=dict)
    executes: list[tuple[str, tuple]] = field(default_factory=list)
    fetchrows: list[tuple[str, tuple]] = field(default_factory=list)

    async def fetchrow(self, sql: str, *args: Any) -> dict | None:
        self.fetchrows.append((sql, args))
        for needle, row in self.canned_fetchrow.items():
            if needle in sql:
                return row
        return None

    async def execute(self, sql: str, *args: Any) -> None:
        self.executes.append((sql, args))


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


@dataclass
class _ToolCapture:
    tools: list[Tool] = field(default_factory=list)

    def __call__(self, tools: Iterable[Tool]) -> None:
        self.tools.extend(tools)


async def _stub_secret(_key: str) -> str | None:
    return None


def _build_ctx(conn: _FakeConn) -> tuple[PluginContext, _ToolCapture]:
    capture = _ToolCapture()
    ctx = PluginContext(
        name="capture",
        db=_StubDb(conn),
        secret=_stub_secret,
        register_router=lambda _r: None,
        register_behaviours=lambda _b: None,
        register_tools=capture,
        identity=None,
    )
    return ctx, capture


def _tool_by_name(tools: list[Tool], name: str) -> Tool:
    return next(t for t in tools if t.name == name)


@pytest.mark.asyncio
async def test_registers_three_tools_on_activate() -> None:
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())
    await plugin.on_activate(ctx)

    names = {t.name for t in capture.tools}
    assert names == {"remember", "note", "event"}


# -----------------------------------------------------------------------------
# remember
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remember_inserts_into_knowledge() -> None:
    new_id = UUID("11111111-1111-1111-1111-111111111111")
    conn = _FakeConn(
        canned_fetchrow={"INTO eidan.knowledge": {"id": new_id}}
    )
    plugin = Plugin()
    ctx, capture = _build_ctx(conn)
    await plugin.on_activate(ctx)
    remember = _tool_by_name(capture.tools, "remember")

    current_identity.set(_identity())
    payload = await remember.handler(
        {
            "skill": "rust",
            "title": "Async basics",
            "body": "Rust async uses futures + a runtime.",
        }
    )
    parsed = json.loads(payload)
    assert parsed["id"] == str(new_id)
    assert parsed["skill"] == "rust"
    # One fetchrow against eidan.knowledge.
    knowledge_inserts = [
        (sql, args) for sql, args in conn.fetchrows
        if "INTO eidan.knowledge" in sql
    ]
    assert len(knowledge_inserts) == 1


@pytest.mark.asyncio
async def test_remember_refuses_empty_field() -> None:
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())
    await plugin.on_activate(ctx)
    remember = _tool_by_name(capture.tools, "remember")

    current_identity.set(_identity())
    with pytest.raises(ToolError):
        await remember.handler({"skill": "rust", "title": "", "body": "x"})


@pytest.mark.asyncio
async def test_remember_refuses_without_identity() -> None:
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())
    await plugin.on_activate(ctx)
    remember = _tool_by_name(capture.tools, "remember")

    current_identity.set(None)
    with pytest.raises(ToolError, match="identity"):
        await remember.handler(
            {"skill": "rust", "title": "t", "body": "b"}
        )


# -----------------------------------------------------------------------------
# note
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_note_inserts_using_loop_provisioned_agent_id() -> None:
    """The `note` tool reads agent_id from the ``current_agent_id``
    contextvar the loop sets at the start of every turn — it no longer
    upserts its own sentinel row."""
    agent_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    note_id = UUID("22222222-2222-2222-2222-222222222222")
    conn = _FakeConn(
        canned_fetchrow={
            "INTO eidan.notes": {"id": note_id},
        }
    )
    plugin = Plugin()
    ctx, capture = _build_ctx(conn)
    await plugin.on_activate(ctx)
    note = _tool_by_name(capture.tools, "note")

    current_identity.set(_identity())
    current_agent_id.set(agent_id)
    payload = await note.handler({"content": "remember: tokio is the default"})
    parsed = json.loads(payload)
    assert parsed["id"] == str(note_id)

    sql_history = [sql for sql, _ in conn.fetchrows]
    # No agent_context write — the plugin reads the id off the contextvar.
    assert not any("INTO eidan.agent_context" in sql for sql in sql_history)
    # The notes INSERT carries the contextvar's agent_id verbatim.
    notes_row = next(
        (args for sql, args in conn.fetchrows if "INTO eidan.notes" in sql),
        None,
    )
    assert notes_row is not None
    assert agent_id in notes_row


@pytest.mark.asyncio
async def test_note_refuses_when_agent_id_missing() -> None:
    """Outside a turn (no loop has run, contextvar is unset), the `note`
    tool refuses with a typed ToolError rather than writing without an
    agent_id."""
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())
    await plugin.on_activate(ctx)
    note = _tool_by_name(capture.tools, "note")

    current_identity.set(_identity())
    current_agent_id.set(None)
    with pytest.raises(ToolError, match="agent_context"):
        await note.handler({"content": "some content"})


@pytest.mark.asyncio
async def test_note_refuses_empty_content() -> None:
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())
    await plugin.on_activate(ctx)
    note = _tool_by_name(capture.tools, "note")

    current_identity.set(_identity())
    current_agent_id.set(UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))
    with pytest.raises(ToolError):
        await note.handler({"content": "   "})


# -----------------------------------------------------------------------------
# event
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_event_inserts_with_due_at() -> None:
    event_id = UUID("33333333-3333-3333-3333-333333333333")
    conn = _FakeConn(
        canned_fetchrow={"INTO eidan.events": {"id": event_id}}
    )
    plugin = Plugin()
    ctx, capture = _build_ctx(conn)
    await plugin.on_activate(ctx)
    event = _tool_by_name(capture.tools, "event")

    current_identity.set(_identity())
    payload = await event.handler(
        {
            "type": "reminder",
            "title": "dentist",
            "due_at": "2026-05-15T19:00:00+01:00",
        }
    )
    parsed = json.loads(payload)
    assert parsed["id"] == str(event_id)
    assert parsed["title"] == "dentist"


@pytest.mark.asyncio
async def test_event_refuses_when_no_timestamp() -> None:
    plugin = Plugin()
    ctx, capture = _build_ctx(_FakeConn())
    await plugin.on_activate(ctx)
    event = _tool_by_name(capture.tools, "event")

    current_identity.set(_identity())
    with pytest.raises(ToolError, match="due_at"):
        await event.handler({"type": "reminder", "title": "x"})


@pytest.mark.asyncio
async def test_event_inserts_with_occurred_at() -> None:
    """Past events (no due_at) are valid — events_time_chk allows either."""
    event_id = UUID("44444444-4444-4444-4444-444444444444")
    conn = _FakeConn(
        canned_fetchrow={"INTO eidan.events": {"id": event_id}}
    )
    plugin = Plugin()
    ctx, capture = _build_ctx(conn)
    await plugin.on_activate(ctx)
    event = _tool_by_name(capture.tools, "event")

    current_identity.set(_identity())
    payload = await event.handler(
        {
            "type": "workout",
            "title": "5k run",
            "occurred_at": "2026-05-13T07:00:00+01:00",
            "duration_seconds": 1800,
        }
    )
    parsed = json.loads(payload)
    assert parsed["id"] == str(event_id)
