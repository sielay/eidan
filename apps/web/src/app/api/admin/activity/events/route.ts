// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/activity/events — SSE stream of node events (eidan.node_events). Emits the recent
// tail, then polls for new rows and pushes them as `data:` frames with keep-alive pings. The client
// (streamActivityEvents) breaks the loop to disconnect, which aborts req.signal and stops polling.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function frame(r: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    node_id: r.node_id,
    seq: Number(r.seq),
    ts: iso(r.ts),
    type: r.type,
    conversation_id: r.conversation_id ?? null,
    payload: (r.payload as Record<string, unknown> | null) ?? {},
  })}\n\n`;
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const enc = new TextEncoder();
  let lastSeq = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(": stream-open\n\n"));
      try {
        const rows = await withUser(sess.userId, async (c) => {
          const r = await c.query(
            "select node_id, seq, ts, type, payload, conversation_id from eidan.node_events order by seq desc limit 50",
          );
          return r.rows as Array<Record<string, unknown>>;
        });
        for (const r of rows.reverse()) {
          lastSeq = Math.max(lastSeq, Number(r.seq));
          controller.enqueue(enc.encode(frame(r)));
        }
      } catch {
        /* table empty / transient — keep the stream open */
      }

      timer = setInterval(() => {
        void (async () => {
          try {
            const rows = await withUser(sess.userId, async (c) => {
              const r = await c.query(
                "select node_id, seq, ts, type, payload, conversation_id from eidan.node_events where seq > $1 order by seq asc limit 100",
                [lastSeq],
              );
              return r.rows as Array<Record<string, unknown>>;
            });
            for (const r of rows) {
              lastSeq = Math.max(lastSeq, Number(r.seq));
              controller.enqueue(enc.encode(frame(r)));
            }
            controller.enqueue(enc.encode(": ping\n\n"));
          } catch {
            /* keep alive */
          }
        })();
      }, 3000);

      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
