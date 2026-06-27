// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/escalations/[id]/acknowledge | /resolve | /respond — advance an escalation's status (docs/022 §3).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id, action } = await ctx.params;

  if (action === "respond") {
    const body = await req.json() as Record<string, unknown>;
    const feedback = body.feedback as string | undefined;
    const reasoning = body.reasoning as string | undefined;
    const decision = body.decision as string | undefined;
    const tags = body.tags as string[] | undefined;
    const nextAgent = body.next_agent as string | undefined;

    if (!feedback) return new Response("feedback is required", { status: 400 });

    const updated = await withUser(sess.userId, async (c) => {
      const response = {
        feedback,
        ...(reasoning && { reasoning }),
        ...(decision && { decision }),
        ...(tags && { tags }),
        ...(nextAgent && { next_agent: nextAgent }),
      };
      const r = await c.query(
        `update eidan.escalations
         set status='responded', response=$2::jsonb, responded_at=now(), responded_by=$3, updated_at=now()
         where id=$1 and user_id=$4 and status in ('pending', 'open', 'acknowledged')`,
        [id, JSON.stringify(response), sess.userId, sess.userId],
      );
      return r.rowCount ?? 0;
    });

    if (updated === 0) return new Response("not found or not in respondable state", { status: 404 });
    return Response.json({ ok: true });
  }

  if (action !== "acknowledge" && action !== "resolve") {
    return new Response("unknown action", { status: 404 });
  }

  const updated = await withUser(sess.userId, async (c) => {
    const sql =
      action === "resolve"
        ? "update eidan.escalations set status='resolved', resolved_at=now(), updated_at=now() where id=$1 and user_id=$2"
        : "update eidan.escalations set status='acknowledged', updated_at=now() where id=$1 and user_id=$2 and status='pending'";
    const r = await c.query(sql, [id, sess.userId]);
    return r.rowCount ?? 0;
  });

  if (updated === 0) return new Response("not found", { status: 404 });
  return Response.json({ ok: true });
}
