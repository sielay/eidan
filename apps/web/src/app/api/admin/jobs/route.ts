// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/jobs — the jobs queue (eidan.jobs), newest first.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 100, 500);

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, kind, goal, status, surface, claimed_by, claimed_at, error, created_at, updated_at
         from eidan.jobs where user_id = $1 order by created_at desc limit ${limit}`,
      [sess.userId],
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    jobs: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      goal: r.goal ?? "",
      status: r.status,
      surface: r.surface ?? null,
      claimed_by: r.claimed_by ?? null,
      claimed_at: r.claimed_at ? iso(r.claimed_at) : null,
      error: r.error ?? null,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    })),
  });
}
