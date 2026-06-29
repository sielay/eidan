// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/version — deployed versions per layer: the web build's own version plus each live engine
// node's version (read from eidan.node_heartbeats.metadata.version, written by the telemetry plugin).
// Cluster-global state (no user_id), so any authenticated operator sees it.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const rows = await withUser(sess.userId, async (c) => {
    // Only nodes seen recently — drops long-dead local/dev nodes from the picture.
    const r = await c.query(
      `select node_id, node_type, status, metadata->>'version' as version, last_seen
         from eidan.node_heartbeats
        where last_seen > now() - interval '2 days'
        order by node_type, last_seen desc nulls last`,
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    web: process.env.EIDAN_WEB_VERSION ?? "dev",
    nodes: rows.map((r) => ({
      node_id: String(r.node_id),
      node_type: r.node_type ? String(r.node_type) : null,
      version: r.version ? String(r.version) : null,
      status: r.status ? String(r.status) : "offline",
    })),
  });
}
