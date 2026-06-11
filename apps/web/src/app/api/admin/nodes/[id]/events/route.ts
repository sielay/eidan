// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/nodes/[id]/events — a node's event tail (eidan.node_events).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const afterSeq = Number(req.nextUrl.searchParams.get("after_seq")) || 0;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 100, 500);

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select node_id, seq, ts, type, payload, conversation_id
         from eidan.node_events where node_id = $1 and seq > $2
         order by seq desc limit ${limit}`,
      [id, afterSeq],
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    node_id: id,
    events: rows.map((r) => ({
      id: `${String(r.node_id)}:${String(r.seq)}`,
      seq: Number(r.seq),
      ts: iso(r.ts),
      type: r.type,
      conversation_id: r.conversation_id ?? null,
      node_id: r.node_id,
      payload: (r.payload as Record<string, unknown> | null) ?? {},
    })),
  });
}
