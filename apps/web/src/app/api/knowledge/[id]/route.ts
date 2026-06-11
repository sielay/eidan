// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/knowledge/[id] — a single knowledge row with its body (docs/014 §5).
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

  let row: Record<string, unknown> | undefined;
  try {
    row = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `select id, slug, title, skill, body, source, created_at, updated_at
           from eidan.knowledge where id = $1 and user_id = $2 and deleted_at is null`,
        [id, sess.userId],
      );
      return r.rows[0] as Record<string, unknown> | undefined;
    });
  } catch {
    // malformed id (e.g. not a uuid) — treat as not found rather than 500
    return new Response("not found", { status: 404 });
  }

  if (!row) return new Response("not found", { status: 404 });

  return Response.json({
    knowledge: {
      id: row.id,
      slug: row.slug ?? null,
      title: row.title ?? null,
      skill: row.skill ?? null,
      body: row.body ?? "",
      source: row.source ?? null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    },
  });
}
