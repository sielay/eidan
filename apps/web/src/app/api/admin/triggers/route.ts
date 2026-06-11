// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/triggers — registered behaviour triggers + dead-letter count. The trigger registry
// is engine runtime state (no table), so the list is empty here; dlq_count is real (eidan.behaviour_dlq).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const dlq = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      "select count(*)::int as n from eidan.behaviour_dlq where status is distinct from 'resolved'",
    );
    return (r.rows[0]?.n as number | undefined) ?? 0;
  });

  return Response.json({ triggers: [], dlq_count: dlq });
}
