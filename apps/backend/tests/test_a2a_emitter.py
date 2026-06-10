# SPDX-License-Identifier: AGPL-3.0-or-later
"""A2A emitter tests (A2A streaming #278).

Drives :class:`A2AEmitter` with a synthetic ``run_turn`` event sequence
and asserts the A2A event stream it produces — task status updates,
message boundaries, artifact events, and the camelCase wire shape.
No DB, no provider — the mapping is pure.
"""

from __future__ import annotations

import json
from uuid import uuid4

from eidan_backend.http.a2a_emitter import A2AEmitter
from eidan_backend.loop import (
    AssistantChunk,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallResult,
    ToolCallStart,
    TurnComplete,
)


def _run(emitter: A2AEmitter, events: list) -> list:
    """Flatten ``start()`` + ``map()`` over a synthetic runner stream."""
    out = list(emitter.start())
    for ev in events:
        out.extend(emitter.map(ev))
    return out


def test_emitter_start_emits_task_and_message() -> None:
    """Verify start() emits task status and initial message."""
    emitter = A2AEmitter(
        task_id="task-1",
        initial_message={"content": "hello"},
        initial_timestamp="2026-01-01T00:00:00Z",
    )
    events = emitter.start()
    assert len(events) == 2
    assert events[0]["event"] == "taskStatusUpdate"
    assert events[0]["data"]["status"] == "running"
    assert events[0]["data"]["taskId"] == "task-1"
    assert events[1]["event"] == "message"
    assert events[1]["data"]["role"] == "user"
    assert events[1]["data"]["content"] == "hello"


def test_emitter_text_message_accumulates() -> None:
    """Text deltas accumulate in the buffer, emitted on turn complete."""
    user_id = uuid4()
    assistant_id = uuid4()
    emitter = A2AEmitter(
        task_id="task-1",
        initial_message={"content": "test"},
        initial_timestamp="2026-01-01T00:00:00Z",
    )
    events = _run(
        emitter,
        [
            AssistantChunk(text="hello "),
            AssistantChunk(text="world"),
            TurnComplete(
                user_message_id=user_id,
                assistant_message_id=assistant_id,
                iterations=1,
            ),
        ],
    )

    # Find the assistant message event (after turn complete)
    msg_events = [e for e in events if e["event"] == "message"]
    assistant_msgs = [e for e in msg_events if e["data"]["role"] == "assistant"]
    assert len(assistant_msgs) == 1
    assert assistant_msgs[0]["data"]["content"] == "hello world"


def test_emitter_tool_call_status_updates() -> None:
    """Tool calls emit status updates during execution."""
    user_id = uuid4()
    assistant_id = uuid4()
    emitter = A2AEmitter(
        task_id="task-1",
        initial_message={"content": "test"},
        initial_timestamp="2026-01-01T00:00:00Z",
    )
    events = _run(
        emitter,
        [
            ToolCallStart(tool_call_id="tc1", tool_name="search"),
            ToolCallArgs(tool_call_id="tc1", args_json='{"q":"x"}'),
            ToolCallEnd(tool_call_id="tc1"),
            ToolCallResult(tool_call_id="tc1", content='{"r":1}', is_error=False),
            TurnComplete(
                user_message_id=user_id,
                assistant_message_id=assistant_id,
                iterations=1,
            ),
        ],
    )

    status_events = [e for e in events if e["event"] == "taskStatusUpdate"]
    # Should have: initial running, tool start, tool result, final completed
    assert any(e["data"]["status"] == "processing_tool" for e in status_events)
    assert any(e["data"]["status"] == "tool_result" for e in status_events)
    assert any(e["data"]["status"] == "completed" for e in status_events)


def test_emitter_artifact_event() -> None:
    """add_artifact() emits a TaskArtifactUpdateEvent with camelCase."""
    emitter = A2AEmitter(
        task_id="task-1",
        initial_message={"content": "test"},
        initial_timestamp="2026-01-01T00:00:00Z",
    )
    artifact_id = uuid4()
    events = emitter.add_artifact(
        artifact_id=artifact_id,
        kind="document",
        filename="result.pdf",
        mime_type="application/pdf",
        size_bytes=1024,
    )

    assert len(events) == 1
    assert events[0]["event"] == "taskArtifactUpdate"
    data = events[0]["data"]
    assert data["taskId"] == "task-1"
    artifact = data["artifact"]
    # camelCase check
    assert "mimeType" in artifact
    assert "sizeBytes" in artifact
    assert "downloadUrl" in artifact
    assert artifact["mimeType"] == "application/pdf"
    assert artifact["sizeBytes"] == 1024


def test_emitter_error_closes_cleanly() -> None:
    """error() emits a status update with error details."""
    emitter = A2AEmitter(
        task_id="task-1",
        initial_message={"content": "test"},
        initial_timestamp="2026-01-01T00:00:00Z",
    )
    events = emitter.error(RuntimeError("boom"))
    assert len(events) == 1
    assert events[0]["event"] == "taskStatusUpdate"
    assert events[0]["data"]["status"] == "error"
    assert "boom" in events[0]["data"]["error"]

    # Idempotent: second error() emits nothing
    assert emitter.error(RuntimeError("again")) == []


def test_emitter_wire_shape_is_camel_case() -> None:
    """Events are dicts with camelCase field names (by_alias)."""
    emitter = A2AEmitter(
        task_id="task-1",
        initial_message={"content": "test"},
        initial_timestamp="2026-01-01T00:00:00Z",
    )
    artifact_id = uuid4()
    events = emitter.add_artifact(
        artifact_id=artifact_id,
        kind="document",
        filename="test.pdf",
        mime_type="application/pdf",
        size_bytes=2048,
    )

    event = events[0]
    # Serialize to JSON to verify camelCase is preserved
    json_str = json.dumps(event)
    data = json.loads(json_str)
    # Check key names are camelCase
    assert "taskId" in data["data"]
    assert "task_id" not in data["data"]
    artifact = data["data"]["artifact"]
    assert "mimeType" in artifact
    assert "mime_type" not in artifact
    assert "sizeBytes" in artifact
    assert "size_bytes" not in artifact
    assert "downloadUrl" in artifact
