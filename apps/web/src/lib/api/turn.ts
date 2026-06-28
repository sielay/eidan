// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { EventType } from "@ag-ui/core";
import { TurnInput } from "@/lib/schemas";

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
  | { kind: "ask_user"; prompt_id: string; field: AskField }
  | { kind: "complete"; user_message_id: string; assistant_message_id: string }
  | { kind: "error"; message: string }
  | { kind: "unknown"; type: string };

/**
 * A single ``ask_user`` form field (mirror of matbot's ``FormField``).
 * The agent emits one when it pauses mid-turn to ask the user something;
 * the turn is blocked server-side until {@link answerPrompt} resolves it.
 */
export interface AskField {
  name: string;
  label: string;
  type: "text" | "password" | "select" | "confirm";
  /** Required when ``type === "select"`` — the mutually-exclusive choices. */
  options?: string[];
  /** select-only: also offer a free-text "Other…" answer. */
  allowOther?: boolean;
  default?: string;
  required?: boolean;
  /** Default true; when false the user must answer and cannot cancel. */
  cancelable?: boolean;
}

export interface TurnRequest {
  conversationId: string;
  text: string;
  /** Optional matbot provider name (the chosen model). Omitted ⇒ server default. */
  provider?: string;
  /** Optional files attached to this turn (base64 data + mime + name). */
  attachments?: Array<{ data: string; mime: string; name?: string }>;
  /** Fork-and-merge: ≥2 provider names to race the prompt against; `provider` judges + merges them. */
  compare?: string[];
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
    ...(req.provider ? { provider: req.provider } : {}),
    ...(req.attachments && req.attachments.length ? { attachments: req.attachments } : {}),
    ...(req.compare && req.compare.length >= 2 ? { compare: req.compare } : {}),
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
    // Not an @ag-ui/core event — an eidan extension (server.ts) carrying a mid-turn ``ask_user``
    // question down the open turn stream. The turn is blocked until we POST an answer back.
    case "ASK_USER": {
      const f = (e.field ?? {}) as Partial<AskField>;
      const field: AskField = {
        name: typeof f.name === "string" ? f.name : "answer",
        label: typeof f.label === "string" ? f.label : "",
        type:
          f.type === "password" || f.type === "select" || f.type === "confirm"
            ? f.type
            : "text",
        ...(Array.isArray(f.options)
          ? { options: f.options.filter((o): o is string => typeof o === "string") }
          : {}),
        ...(typeof f.allowOther === "boolean" ? { allowOther: f.allowOther } : {}),
        ...(typeof f.default === "string" ? { default: f.default } : {}),
        ...(typeof f.required === "boolean" ? { required: f.required } : {}),
        ...(typeof f.cancelable === "boolean" ? { cancelable: f.cancelable } : {}),
      };
      return { kind: "ask_user", prompt_id: String(e.promptId ?? ""), field };
    }
    default:
      return { kind: "unknown", type: String(type ?? "unknown") };
  }
}

/**
 * Answer (or cancel) a parked ``ask_user`` prompt. The turn's SSE stream
 * is still open and blocked inside the tool; this settles it server-side
 * and the turn streams on over that same connection. ``cancel: true`` is
 * the "give up" path — the tool reports it as an error and the turn ends.
 */
export async function answerPrompt(args: {
  conversationId: string;
  promptId: string;
  answer?: string;
  cancel?: boolean;
}): Promise<void> {
  const res = await authFetch("/api/turn/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversation_id: args.conversationId,
      prompt_id: args.promptId,
      ...(args.cancel ? { cancel: true } : { answer: args.answer ?? "" }),
    }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/turn/answer returned ${res.status}`);
  }
}
