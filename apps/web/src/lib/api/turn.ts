"use client";

import { EventType } from "@ag-ui/core";
import { TurnInput } from "@eidan/schemas";

import { authFetch } from "@/lib/auth";

/**
 * One decoded event from ``POST /api/turn``.
 *
 * The backend speaks **AG-UI** (the Agent-User Interaction Protocol —
 * eidan's protocol of record, #263). Each SSE frame is a single
 * ``data: {json}`` line whose ``type`` is one of AG-UI's event names and
 * whose payload keys are camelCase (the documented carve-out — see the
 * backend ``docs/004``). This module decodes that wire into the slim,
 * snake_case union the chat panel actually reduces over; we keep the
 * client-internal shape snake_case to match the rest of the app rather
 * than leaking AG-UI's camelCase past this boundary.
 *
 * The AG-UI event vocabulary is far larger than this; we surface only
 * what the Phase-1 chat panel renders and pass everything else through
 * as ``unknown`` so the wire can grow without forcing a UI rebuild:
 *
 * - ``text`` — an assistant text delta (``TEXT_MESSAGE_CONTENT``).
 * - ``tool_call_start`` / ``tool_call_args`` / ``tool_call_result`` —
 *   a tool call unfolding live (#265): the model emits it, its
 *   arguments stream in, then the local result lands.
 * - ``complete`` — the run finished (``RUN_FINISHED``); carries the
 *   persisted message ids the loop wrote, for reconciliation.
 * - ``error`` — the run failed (``RUN_ERROR``).
 *
 * ``TEXT_MESSAGE_START`` / ``END`` boundaries are intentionally not
 * surfaced: a turn that interleaves text → tool → text produces two
 * AG-UI text messages, and concatenating every ``text`` delta recovers
 * the full assistant text in a single streaming bubble.
 */
export type TurnEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call_start"; tool_call_id: string; tool_name: string }
  | { kind: "tool_call_args"; tool_call_id: string; args_delta: string }
  | { kind: "tool_call_result"; tool_call_id: string; content: string }
  | { kind: "complete"; user_message_id: string; assistant_message_id: string }
  | { kind: "error"; message: string }
  | { kind: "unknown"; type: string };

export interface TurnRequest {
  conversationId: string;
  text: string;
  signal?: AbortSignal;
}

/**
 * Resolve the browser's IANA time zone. Issue #51 — every outbound
 * turn carries it so the loop renders relative time references against
 * the user's clock, not the server's.
 *
 * Falls back to ``UTC`` if ``Intl.DateTimeFormat`` is unavailable (very
 * old browsers; not a real path in our supported matrix, but cheaper
 * than failing the turn).
 */
function resolveUserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Drive one turn and yield decoded AG-UI events as they arrive.
 *
 * The browser's ``EventSource`` API does not support custom request
 * headers, so we open the stream with ``fetch`` and parse SSE frames
 * off the response body manually. AG-UI frames are delimited by a blank
 * line per the SSE spec and carry their payload on ``data:`` lines; the
 * event name lives inside the JSON (there is no named ``event:`` line).
 *
 * Throws on non-2xx HTTP status. Stream interruptions surface to the
 * caller as the iterator ending early; the partial assistant content
 * the caller has accumulated is preserved (`docs/014 §4.6`).
 */
export async function* streamTurn(
  req: TurnRequest,
): AsyncGenerator<TurnEvent, void, void> {
  // The request body stays an eidan-owned, snake_case DTO (TurnInput) —
  // only the *response* stream is AG-UI.
  const body: TurnInput = TurnInput.parse({
    conversation_id: req.conversationId,
    text: req.text,
    sent_at_utc: new Date().toISOString(),
    user_tz: resolveUserTz(),
  });

  const res = await authFetch("/api/turn", {
    method: "POST",
    headers: { Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`POST /api/turn returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseFrame(raw);
        if (event) yield event;
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Decode one SSE frame (the bytes between two blank lines) into a
 * :type:`TurnEvent`. Exported for unit testing — production callers go
 * through :func:`streamTurn`.
 *
 * Returns ``null`` when the frame has no ``data:`` payload (an SSE
 * comment / keep-alive) or when the payload isn't valid JSON.
 */
export function parseFrame(raw: string): TurnEvent | null {
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment / keep-alive
    if (line.startsWith("data:")) {
      const piece = line.slice("data:".length).replace(/^ /, "");
      data = data ? `${data}\n${piece}` : piece;
    }
  }
  if (!data) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  return decodeAguiEvent(parsed);
}

/**
 * Map one AG-UI event object onto the slim :type:`TurnEvent` union.
 * Keys are AG-UI's camelCase; the output is the app's snake_case shape.
 */
function decodeAguiEvent(e: Record<string, unknown>): TurnEvent {
  const type = e.type;
  switch (type) {
    case EventType.TEXT_MESSAGE_CONTENT:
      return { kind: "text", delta: String(e.delta ?? "") };
    case EventType.TOOL_CALL_START:
      return {
        kind: "tool_call_start",
        tool_call_id: String(e.toolCallId ?? ""),
        tool_name: String(e.toolCallName ?? ""),
      };
    case EventType.TOOL_CALL_ARGS:
      return {
        kind: "tool_call_args",
        tool_call_id: String(e.toolCallId ?? ""),
        args_delta: String(e.delta ?? ""),
      };
    case EventType.TOOL_CALL_RESULT:
      return {
        kind: "tool_call_result",
        tool_call_id: String(e.toolCallId ?? ""),
        content: String(e.content ?? ""),
      };
    case EventType.RUN_FINISHED: {
      const result = (e.result ?? {}) as Record<string, unknown>;
      return {
        kind: "complete",
        user_message_id: String(result.user_message_id ?? ""),
        assistant_message_id: String(result.assistant_message_id ?? ""),
      };
    }
    case EventType.RUN_ERROR:
      return { kind: "error", message: String(e.message ?? "run failed") };
    default:
      return { kind: "unknown", type: String(type ?? "unknown") };
  }
}
