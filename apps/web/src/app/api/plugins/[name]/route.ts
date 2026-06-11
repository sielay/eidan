// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/plugins/[name] — a single installed plugin (eidan.plugin_state).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { name } = await ctx.params;

  const row = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      "select name, version, installed_at, updated_at from eidan.plugin_state where name = $1",
      [name],
    );
    return r.rows[0] as Record<string, unknown> | undefined;
  });

  if (!row) return new Response("not found", { status: 404 });

  return Response.json({
    name: row.name,
    display_name: row.name,
    tier: "core",
    version: row.version ?? "",
    description: null,
    enabled: true,
    author: null,
    installed_at: iso(row.installed_at),
    updated_at: iso(row.updated_at),
    commands: [],
  });
}
