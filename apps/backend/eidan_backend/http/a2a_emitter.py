# SPDX-License-Identifier: AGPL-3.0-or-later
"""A2A emitter — maps the turn runner's event stream onto A2A events.

Similar to AG-UI's emitter (docs/030 #263), the A2A protocol streams
status updates and artifacts as SSE events during a turn. The emitter
is a stateful map that translates runner events (AssistantChunk,
ToolCallStart, etc.) into A2A protocol events: TaskStatusUpdateEvent
and TaskArtifactUpdateEvent.

Like AguiEmitter, this is a pure, unit-testable mapping with no DB
or request coupling — the HTTP handler keeps ownership of side-effects.

A2A emits camelCase (by_alias) and nests the event type inside the
JSON structure per the A2A JSON-RPC protocol.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from ..loop import (
    AssistantChunk,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallResult,
    ToolCallStart,
    TurnComplete,
    TurnEvent,
)


class A2AEmitter:
    """Maps a single turn's ``run_turn`` events onto A2A events.

    One instance per turn. The HTTP handler drives it::

        emitter = A2AEmitter(task_id=task_id, initial_message={...})
        for ev in emitter.start():
            yield json.dumps(ev)
        async for event in run_turn(...):
            for ev in emitter.map(event):
                yield json.dumps(ev)
        # on exception:
        for ev in emitter.error(exc):
            yield json.dumps(ev)

    ``map`` returns zero or more A2A events for one runner event;
    ``start`` opens the task; ``error`` closes a failed task.
    Events are returned as dicts ready for JSON serialization with
    camelCase field names (by_alias).
    """

    def __init__(
        self,
        *,
        task_id: str,
        initial_message: dict[str, str],
        initial_timestamp: str,
    ) -> None:
        self.task_id = task_id
        self.initial_message = initial_message
        self.initial_timestamp = initial_timestamp
        self._finished = False
        self._text_buffer = ""
        self._tool_call_active: str | None = None

    def start(self) -> list[dict[str, Any]]:
        """Open the task. Emit once, before iterating the turn."""
        events = [
            {
                "event": "taskStatusUpdate",
                "data": {
                    "taskId": self.task_id,
                    "status": "running",
                    "createdAt": self.initial_timestamp,
                    "updatedAt": self.initial_timestamp,
                },
            },
            {
                "event": "message",
                "data": {
                    "taskId": self.task_id,
                    "role": "user",
                    "content": self.initial_message.get("content", ""),
                    "timestamp": self.initial_timestamp,
                },
            },
        ]
        return events

    def map(self, event: TurnEvent) -> list[dict[str, Any]]:
        """Translate one runner event into its A2A events."""
        if isinstance(event, AssistantChunk):
            self._text_buffer += event.text
            # Emit intermediate updates periodically via the status event
            # (the full text will be in the final message)
            return []
        if isinstance(event, ToolCallStart):
            self._tool_call_active = event.tool_call_id
            # Emit status showing tool execution
            return [
                {
                    "event": "taskStatusUpdate",
                    "data": {
                        "taskId": self.task_id,
                        "status": "processing_tool",
                        "toolName": event.tool_name,
                        "toolCallId": event.tool_call_id,
                    },
                }
            ]
        if isinstance(event, ToolCallArgs):
            # Tool args are part of the tool call metadata, not emitted separately
            return []
        if isinstance(event, ToolCallEnd):
            return []
        if isinstance(event, ToolCallResult):
            self._tool_call_active = None
            return [
                {
                    "event": "taskStatusUpdate",
                    "data": {
                        "taskId": self.task_id,
                        "status": "tool_result",
                        "toolCallId": event.tool_call_id,
                        "isError": event.is_error,
                    },
                }
            ]
        if isinstance(event, TurnComplete):
            return self._on_complete(event)
        # Unknown future event types pass silently
        return []

    def error(self, exc: BaseException) -> list[dict[str, Any]]:
        """Close a failed task with a status update."""
        if self._finished:
            return []
        self._finished = True
        return [
            {
                "event": "taskStatusUpdate",
                "data": {
                    "taskId": self.task_id,
                    "status": "error",
                    "error": str(exc) or type(exc).__name__,
                },
            }
        ]

    def add_artifact(
        self,
        *,
        artifact_id: UUID,
        kind: str,
        filename: str,
        mime_type: str,
        size_bytes: int,
    ) -> list[dict[str, Any]]:
        """Emit a TaskArtifactUpdateEvent for a newly-produced artifact."""
        if self._finished:
            return []
        return [
            {
                "event": "taskArtifactUpdate",
                "data": {
                    "taskId": self.task_id,
                    "artifact": {
                        "id": str(artifact_id),
                        "kind": kind,
                        "filename": filename,
                        "mimeType": mime_type,
                        "sizeBytes": size_bytes,
                        "downloadUrl": f"/api/artifacts/{artifact_id}",
                    },
                },
            }
        ]

    # -- internals --------------------------------------------------------

    def _on_complete(self, event: TurnComplete) -> list[dict[str, Any]]:
        self._finished = True
        # Emit the final assistant message
        events = []
        if self._text_buffer:
            events.append(
                {
                    "event": "message",
                    "data": {
                        "taskId": self.task_id,
                        "role": "assistant",
                        "content": self._text_buffer,
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                }
            )
        # Emit final status
        events.append(
            {
                "event": "taskStatusUpdate",
                "data": {
                    "taskId": self.task_id,
                    "status": "completed",
                    "userMessageId": str(event.user_message_id),
                    "assistantMessageId": str(event.assistant_message_id),
                    "iterations": event.iterations,
                },
            }
        )
        return events


__all__: Iterable[str] = ["A2AEmitter"]
