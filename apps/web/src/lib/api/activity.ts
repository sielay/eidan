// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/** One frame from `GET /api/admin/activity/events` (#155). */
export interface ActivityEvent {
  node_id: string;
  seq: number;
  ts: string;
  type: string;
  conversation_id: string | null;
  payload: Record<string, unknown>;
}

/** Async iterator over the SSE stream. Parses each `data: …\n\n` frame
 *  and yields the decoded event. Comment frames (`: ping`, `: stream-open`)
 *  are skipped. The caller breaks the loop to disconnect.
 *
 *  Mirrors the `lib/api/turn.ts` pattern (fetch-stream rather than
 *  EventSource) so the bearer token rides on the request like every
 *  other authenticated call. */
export async function* streamActivityEvents(
  signal: AbortSignal,
): AsyncGenerator<ActivityEvent, void, void> {
  const res = await authFetch("/api/admin/activity/events", {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `GET /api/admin/activity/events returned ${res.status}`,
    );
  }
  if (res.body === null) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const sep = buffer.indexOf("\n\n");
        if (sep === -1) break;
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const rawLine of frame.split("\n")) {
          const line = rawLine.trim();
          if (line.length === 0) continue;
          if (line.startsWith(":")) continue; // comment frame
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload.length === 0) continue;
            try {
              yield JSON.parse(payload) as ActivityEvent;
            } catch {
              // Malformed frame — ignore and keep going.
            }
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}
