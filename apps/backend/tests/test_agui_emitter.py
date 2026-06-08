# SPDX-License-Identifier: AGPL-3.0-or-later
"""AG-UI emitter tests (#263 / #266).

Drives :class:`AguiEmitter` with a synthetic ``run_turn`` event sequence
and asserts the AG-UI event stream it produces — lifecycle bracketing,
text-message boundaries, tool-call correlation, persisted-id hand-off on
``RUN_FINISHED``, and the camelCase SSE wire shape (the documented
carve-out). No DB, no provider — the mapping is pure.
"""

from __future__ import annotations

import json
from uuid import uuid4

from ag_ui.encoder import EventEncoder
from eidan_backend.http.agui import AguiEmitter
from eidan_backend.loop import (
    AssistantChunk,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallResult,
    ToolCallStart,
    TurnComplete,
)


def _run(emitter: AguiEmitter, events: list) -> list:
    """Flatten ``start()`` + ``map()`` over a synthetic runner stream."""
    out = list(emitter.start())
    for ev in events:
        out.extend(emitter.map(ev))
    return out


def test_emitter_maps_text_tool_text_turn() -> None:
    user_id = uuid4()
    assistant_id = uuid4()
    runner = [
        AssistantChunk(text="Let me "),
        AssistantChunk(text="search."),
        ToolCallStart(tool_call_id="tc1", tool_name="search"),
        ToolCallArgs(tool_call_id="tc1", args_json='{"q":"x"}'),
        ToolCallEnd(tool_call_id="tc1"),
        ToolCallResult(tool_call_id="tc1", content='{"r":1}', is_error=False),
        AssistantChunk(text="Found it."),
        TurnComplete(
            user_message_id=user_id,
            assistant_message_id=assistant_id,
            iterations=2,
        ),
    ]
    emitter = AguiEmitter(thread_id="conv-1")
    events = _run(emitter, runner)
    types = [type(e).__name__ for e in events]

    assert types == [
        "RunStartedEvent",
        "TextMessageStartEvent",
        "TextMessageContentEvent",
        "TextMessageContentEvent",
        "TextMessageEndEvent",  # text closed by the tool call
        "ToolCallStartEvent",
        "ToolCallArgsEvent",
        "ToolCallEndEvent",
        "ToolCallResultEvent",
        "TextMessageStartEvent",  # second text run after the tool
        "TextMessageContentEvent",
        "TextMessageEndEvent",  # closed by RUN_FINISHED
        "RunFinishedEvent",
    ]

    by_type: dict[str, list] = {}
    for e in events:
        by_type.setdefault(type(e).__name__, []).append(e)

    # Two distinct text runs, each internally consistent.
    starts = by_type["TextMessageStartEvent"]
    ends = by_type["TextMessageEndEvent"]
    contents = by_type["TextMessageContentEvent"]
    assert starts[0].message_id == ends[0].message_id
    assert starts[1].message_id == ends[1].message_id
    assert starts[0].message_id != starts[1].message_id
    # First run carries both pre-tool deltas, second carries the tail.
    first_run = [c for c in contents if c.message_id == starts[0].message_id]
    assert "".join(c.delta for c in first_run) == "Let me search."
    second_run = [c for c in contents if c.message_id == starts[1].message_id]
    assert "".join(c.delta for c in second_run) == "Found it."

    # Tool quartet shares the runner's tool_call_id.
    assert by_type["ToolCallStartEvent"][0].tool_call_id == "tc1"
    assert by_type["ToolCallStartEvent"][0].tool_call_name == "search"
    assert by_type["ToolCallArgsEvent"][0].delta == '{"q":"x"}'
    assert by_type["ToolCallEndEvent"][0].tool_call_id == "tc1"
    assert by_type["ToolCallResultEvent"][0].tool_call_id == "tc1"
    assert by_type["ToolCallResultEvent"][0].content == '{"r":1}'

    # Lifecycle ids are stable across the run, and the persisted ids ride
    # out on RUN_FINISHED for client reconciliation.
    run_started = by_type["RunStartedEvent"][0]
    run_finished = by_type["RunFinishedEvent"][0]
    assert run_started.run_id == run_finished.run_id
    assert run_started.thread_id == run_finished.thread_id == "conv-1"
    assert run_finished.result["user_message_id"] == str(user_id)
    assert run_finished.result["assistant_message_id"] == str(assistant_id)
    assert run_finished.result["iterations"] == 2


def test_emitter_text_only_turn_brackets_one_message() -> None:
    emitter = AguiEmitter(thread_id="conv-2")
    events = _run(
        emitter,
        [
            AssistantChunk(text="hello"),
            TurnComplete(user_message_id=uuid4(), assistant_message_id=uuid4()),
        ],
    )
    assert [type(e).__name__ for e in events] == [
        "RunStartedEvent",
        "TextMessageStartEvent",
        "TextMessageContentEvent",
        "TextMessageEndEvent",
        "RunFinishedEvent",
    ]


def test_emitter_error_closes_open_text_then_run_error() -> None:
    emitter = AguiEmitter(thread_id="conv-3")
    out = list(emitter.start())
    out.extend(emitter.map(AssistantChunk(text="partial")))
    # A failure mid-text: the open text message is closed, then RUN_ERROR.
    out.extend(emitter.error(RuntimeError("boom")))
    types = [type(e).__name__ for e in out]
    assert types == [
        "RunStartedEvent",
        "TextMessageStartEvent",
        "TextMessageContentEvent",
        "TextMessageEndEvent",
        "RunErrorEvent",
    ]
    assert out[-1].message == "boom"
    # Idempotent: a second error() (or a stray map) emits nothing.
    assert emitter.error(RuntimeError("again")) == []


def test_emitter_wire_shape_is_camelcase_single_data_frame() -> None:
    """The SDK encoder frames each event as one ``data:`` line with
    camelCase keys and the event name inside ``type`` — the carve-out
    from eidan's named-event/snake_case convention (docs/004)."""
    emitter = AguiEmitter(thread_id="conv-4")
    encoder = EventEncoder()
    frame = encoder.encode(emitter.start()[0])
    assert frame.startswith("data: ")
    assert frame.endswith("\n\n")
    assert "event:" not in frame
    payload = json.loads(frame[len("data: ") :])
    assert payload["type"] == "RUN_STARTED"
    assert payload["threadId"] == "conv-4"  # camelCase, not thread_id
    assert "runId" in payload
