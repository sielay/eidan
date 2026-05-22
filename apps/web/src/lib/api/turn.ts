"use client";

import { TurnChunk, TurnComplete, TurnInput } from "@eidan/schemas";

import { authFetch } from "@/lib/auth";

/**
 * One decoded SSE event from ``POST /api/turn`` (`docs/005 §5.5`).
 *
 * The backend emits two named events today:
 *
 * - ``chunk`` — incremental assistant text. Multiple per turn.
 * - ``complete`` — terminal event carrying the persisted message ids.
 *
 * Anything else is surfaced as ``unknown`` so the caller can decide
 * whether to ignore or render it; the wire shape is allowed to grow
 * (e.g. tool / failure events) without forcing a UI rebuild.
 *
 * The ``chunk`` and ``complete`` payload shapes are pinned by
 * ``@eidan/schemas`` (``TurnChunk`` / ``TurnComplete``) so a wire
 * change propagates through codegen rather than via hand-edited
 * mirrors here.
 */
export type TurnEvent =
  | ({ kind: "chunk" } & TurnChunk)
  | ({ kind: "complete" } & TurnComplete)
  | { kind: "unknown"; event: string; data: string };

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
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    );
  } catch {
    return "UTC";
  }
}

/**
 * Drive one turn and yield decoded SSE events as they arrive.
 *
 * The browser's ``EventSource`` API does not support custom request
 * headers, so we open the stream with ``fetch`` and parse SSE frames
 * off the response body manually. Frames are delimited by a blank
 * line per the SSE spec; ``event:`` and ``data:`` lines compose the
 * frame.
 *
 * Throws on non-2xx HTTP status. Stream interruptions surface to the
 * caller as the iterator ending early; the partial assistant content
 * the caller has accumulated is preserved (`docs/014 §4.6`).
 */
export async function* streamTurn(
  req: TurnRequest,
): AsyncGenerator<TurnEvent, void, void> {
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
 * :type:`TurnEvent`. Exported for unit testing — production
 * callers go through :func:`streamTurn`.
 *
 * Returns ``null`` when the frame has no `data:` payload (a pure
 * comment-only frame or a malformed one).
 */
export function parseFrame(raw: string): TurnEvent | null {
  let name = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment
    if (line.startsWith("event:")) {
      name = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      const piece = line.slice("data:".length).replace(/^ /, "");
      data = data ? `${data}\n${piece}` : piece;
    }
  }
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (name === "chunk") {
      const chunk = TurnChunk.safeParse(parsed);
      if (chunk.success) return { kind: "chunk", ...chunk.data };
    } else if (name === "complete") {
      const complete = TurnComplete.safeParse(parsed);
      if (complete.success) return { kind: "complete", ...complete.data };
    }
    return { kind: "unknown", event: name, data };
  } catch {
    return { kind: "unknown", event: name, data };
  }
}
