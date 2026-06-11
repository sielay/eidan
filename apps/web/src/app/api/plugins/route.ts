// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/plugins — installed plugins snapshot (eidan.plugin_state) + the most-recent node identity.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const { plugins, node } = await withUser(sess.userId, async (c) => {
    const p = await c.query(
      "select name, version from eidan.plugin_state order by name",
    );
    const n = await c.query(
      "select node_id, node_type from eidan.node_heartbeats order by last_seen desc nulls last limit 1",
    );
    return { plugins: p.rows as Array<Record<string, unknown>>, node: n.rows[0] as Record<string, unknown> | undefined };
  });

  return Response.json({
    node: node ? { node_id: node.node_id, node_type: node.node_type ?? "" } : null,
    plugins: plugins.map((r) => ({
      name: r.name,
      display_name: r.name,
      tier: "core",
      version: r.version ?? "",
      description: null,
      enabled: true,
    })),
  });
}
