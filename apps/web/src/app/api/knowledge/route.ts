// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/knowledge[?skill=&limit=] — the knowledge index (docs/014 §5, docs/017). Body omitted
// in the list; /api/knowledge/[id] returns it for the detail panel.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const skill = req.nextUrl.searchParams.get("skill");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 200, 500);

  const rows = await withUser(sess.userId, async (c) => {
    const params: unknown[] = [sess.userId];
    let where = "user_id = $1 and deleted_at is null";
    if (skill) {
      params.push(skill);
      where += ` and skill = $${params.length}`;
    }
    const r = await c.query(
      `select id, slug, title, skill, left(body, 200) as summary, created_at, updated_at
         from eidan.knowledge where ${where}
         order by updated_at desc nulls last limit ${limit}`,
      params,
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    knowledge: rows.map((r) => ({
      id: r.id,
      slug: r.slug ?? null,
      title: r.title ?? null,
      skill: r.skill ?? null,
      summary: typeof r.summary === "string" ? r.summary.replace(/\s+/g, " ").trim() : "",
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    })),
  });
}
