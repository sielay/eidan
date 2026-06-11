// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/nodes — cluster node heartbeats (eidan.node_heartbeats). Cluster-global state
// (no user_id), so any authenticated operator sees it.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select node_id, node_type, status, last_seen, plugins, served_kinds
         from eidan.node_heartbeats order by last_seen desc nulls last`,
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    nodes: rows.map((r) => {
      const last = r.last_seen ? new Date(String(r.last_seen)).getTime() : 0;
      return {
        node_id: r.node_id,
        node_type: r.node_type ?? null,
        status: r.status ?? "offline",
        last_seen: r.last_seen ? iso(r.last_seen) : "",
        seconds_since: last ? Math.max(0, Math.round((Date.now() - last) / 1000)) : -1,
        plugins: Array.isArray(r.plugins) ? r.plugins : [],
        served_kinds: Array.isArray(r.served_kinds) ? r.served_kinds : [],
      };
    }),
  });
}
