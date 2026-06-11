// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/knowledge/[id]/neighbours — the knowledge rows linked to/from this one (wikilink graph,
// eidan.knowledge_links). Depth-1 neighbours; powers the related-notes panel + wikilink resolution.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 50, 200);

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `select distinct k.id, k.slug, k.title
           from eidan.knowledge_links l
           join eidan.knowledge k
             on k.id = case when l.from_knowledge_id = $1 then l.to_knowledge_id else l.from_knowledge_id end
          where (l.from_knowledge_id = $1 or l.to_knowledge_id = $1)
            and l.user_id = $2 and k.user_id = $2 and k.deleted_at is null and k.id <> $1
          limit ${limit}`,
        [id, sess.userId],
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  } catch {
    rows = []; // malformed id / no links — empty graph, not an error
  }

  return Response.json({
    seed_id: id,
    depth: 1,
    neighbours: rows.map((r) => ({ id: r.id, slug: r.slug ?? null, title: r.title ?? null, hops: 1 })),
  });
}
