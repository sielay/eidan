# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for the REPL's AG-UI SSE decoder (#263 / #268).

The HTTP-fallback REPL consumes ``POST /api/turn``, which streams AG-UI
events: one ``data:`` JSON payload per frame (no ``event:`` line), the
event name in ``type``, camelCase keys. ``_parse_sse`` splits a byte
buffer into parsed event dicts plus the trailing partial frame.
"""

from __future__ import annotations

from eidan_cli.repl import _parse_sse


def test_parse_sse_decodes_agui_frames_and_keeps_partial() -> None:
    buffer = (
        'data: {"type":"RUN_STARTED","threadId":"c1","runId":"r1"}\n\n'
        'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hi"}\n\n'
        'data: {"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"search"}\n\n'
        # A trailing, not-yet-terminated frame must be returned as the partial.
        'data: {"type":"RUN_FIN'
    )
    events, partial = _parse_sse(buffer)
    assert [e["type"] for e in events] == [
        "RUN_STARTED",
        "TEXT_MESSAGE_CONTENT",
        "TOOL_CALL_START",
    ]
    assert events[1]["delta"] == "hi"
    assert events[2]["toolCallName"] == "search"
    assert partial == 'data: {"type":"RUN_FIN'


def test_parse_sse_drops_comments_and_unparseable_frames() -> None:
    buffer = (
        ": keep-alive\n\n"
        "data: not json at all\n\n"
        'data: {"type":"RUN_FINISHED","threadId":"c1","runId":"r1","result":{}}\n\n'
    )
    events, partial = _parse_sse(buffer)
    assert [e["type"] for e in events] == ["RUN_FINISHED"]
    assert partial == ""
