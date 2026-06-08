# SPDX-License-Identifier: AGPL-3.0-or-later
"""AG-UI emitter — maps the turn runner's event stream onto AG-UI events.

eidan speaks [AG-UI](https://github.com/ag-ui-protocol/ag-ui) as its
agent↔frontend protocol of record (#263). ``run_turn`` (``loop.py``)
yields a small set of internal events — assistant text chunks, the
tool-call quartet (#265), and a terminal ``TurnComplete``. This module
translates that stream into the standard AG-UI event vocabulary so any
AG-UI-speaking surface (the web client, later the CLI / Slack) can render
a turn live without knowing anything eidan-private.

The translation is a **stateful map**, not a generator, on purpose: the
HTTP handler keeps ownership of the side-effects it must run alongside
the stream — client-disconnect checks and the fire-and-forget auto-title
hook keyed on ``TurnComplete`` — so the emitter stays a pure, unit-
testable mapping with no DB or request coupling.

Two protocol notes (the carve-outs documented in ``docs/004``):

- AG-UI serialises **camelCase** (`messageId`, `toolCallId`) and carries
  the event name *inside* the JSON ``type`` field — the SSE framing is a
  single ``data:`` line per event, encoded by ``ag_ui.encoder``. This is
  not eidan's named-`event:`/snake_case shape; it is the standard's, and
  intentionally so.
- The AG-UI event types come from the SDK (``ag_ui.core``), not from
  ``@eidan/schemas`` codegen.

Text bracketing: ``run_turn`` streams raw text deltas without explicit
message boundaries. The emitter lazily opens a ``TEXT_MESSAGE`` on the
first delta and closes it when a tool call interrupts the text or the
turn finishes. A turn that interleaves text → tool → text therefore
produces two AG-UI text messages; concatenating same-turn text messages
on the client recovers the full assistant text. The persisted message
ids (today's terminal payload) ride out on ``RUN_FINISHED.result`` so a
surface can reconcile the live stream with ``eidan.messages`` on reload.
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID, uuid4

from ag_ui.core import (
    BaseEvent,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)

from ..loop import (
    AssistantChunk,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallResult,
    ToolCallStart,
    TurnComplete,
    TurnEvent,
)


class AguiEmitter:
    """Maps a single turn's ``run_turn`` events onto AG-UI events.

    One instance per turn. The HTTP handler drives it::

        emitter = AguiEmitter(thread_id=str(conversation_id))
        for ev in emitter.start():
            yield encoder.encode(ev)
        async for event in run_turn(...):
            for ev in emitter.map(event):
                yield encoder.encode(ev)
        # on exception:
        for ev in emitter.error(exc):
            yield encoder.encode(ev)

    ``map`` returns zero or more AG-UI events for one runner event;
    ``start`` opens the run; ``error`` closes a failed run with a
    ``RUN_ERROR`` (after closing any open text message).
    """

    def __init__(self, *, thread_id: str, run_id: str | None = None) -> None:
        self.thread_id = thread_id
        # A run id correlates every event of one turn. Synthetic — the
        # client only needs it to be stable within the stream.
        self.run_id = run_id or _new_id()
        # The id of the currently-open AG-UI text message, or None when no
        # text run is open. Tool calls and run-finish close it.
        self._text_message_id: str | None = None
        self._finished = False

    def start(self) -> list[BaseEvent]:
        """Open the run. Emit once, before iterating the turn."""
        return [RunStartedEvent(thread_id=self.thread_id, run_id=self.run_id)]

    def map(self, event: TurnEvent) -> list[BaseEvent]:
        """Translate one runner event into its AG-UI events."""
        if isinstance(event, AssistantChunk):
            return self._on_text(event.text)
        if isinstance(event, ToolCallStart):
            return self._on_tool_start(event)
        if isinstance(event, ToolCallArgs):
            return [
                ToolCallArgsEvent(
                    tool_call_id=event.tool_call_id, delta=event.args_json
                )
            ]
        if isinstance(event, ToolCallEnd):
            return [ToolCallEndEvent(tool_call_id=event.tool_call_id)]
        if isinstance(event, ToolCallResult):
            return [
                ToolCallResultEvent(
                    message_id=_new_id(),
                    tool_call_id=event.tool_call_id,
                    content=event.content,
                    role="tool",
                )
            ]
        if isinstance(event, TurnComplete):
            return self._on_complete(event)
        # Unknown future event types pass silently — the stream stays
        # forward-compatible (mirrors how consumers ignore unknown events).
        return []

    def error(self, exc: BaseException) -> list[BaseEvent]:
        """Close a failed run: end any open text, then a RUN_ERROR."""
        if self._finished:
            return []
        self._finished = True
        out = self._close_text()
        out.append(RunErrorEvent(message=str(exc) or type(exc).__name__))
        return out

    # -- internals -----------------------------------------------------

    def _on_text(self, delta: str) -> list[BaseEvent]:
        out: list[BaseEvent] = []
        if self._text_message_id is None:
            self._text_message_id = _new_id()
            out.append(TextMessageStartEvent(message_id=self._text_message_id))
        out.append(
            TextMessageContentEvent(message_id=self._text_message_id, delta=delta)
        )
        return out

    def _on_tool_start(self, event: ToolCallStart) -> list[BaseEvent]:
        # A tool call interrupts any open text run — close it first so the
        # text message is well-formed before the tool call opens.
        out = self._close_text()
        out.append(
            ToolCallStartEvent(
                tool_call_id=event.tool_call_id,
                tool_call_name=event.tool_name,
            )
        )
        return out

    def _on_complete(self, event: TurnComplete) -> list[BaseEvent]:
        self._finished = True
        out = self._close_text()
        out.append(
            RunFinishedEvent(
                thread_id=self.thread_id,
                run_id=self.run_id,
                # Carry the persisted ids so a reloading client can
                # reconcile the live stream with eidan.messages. Stringified
                # because AG-UI ``result`` is free-form JSON.
                result={
                    "user_message_id": _uuid_str(event.user_message_id),
                    "assistant_message_id": _uuid_str(event.assistant_message_id),
                    "iterations": event.iterations,
                },
            )
        )
        return out

    def _close_text(self) -> list[BaseEvent]:
        if self._text_message_id is None:
            return []
        end = TextMessageEndEvent(message_id=self._text_message_id)
        self._text_message_id = None
        return [end]


def _new_id() -> str:
    return uuid4().hex


def _uuid_str(value: UUID | str) -> str:
    return str(value)


__all__: Iterable[str] = ["AguiEmitter"]
