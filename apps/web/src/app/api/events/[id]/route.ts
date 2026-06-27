// SPDX-License-Identifier: AGPL-3.0-or-later
// PATCH/DELETE /api/events/[id] — mutate a single event from the Memory → Events tab. PATCH sets the
// status (mark done / reopen, stamping occurred_at on completion); DELETE soft-archives it. Owner-scoped.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;

  let body: { status?: unknown; body?: unknown };
  try {
    body = (await req.json()) as { status?: unknown; body?: unknown };
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const status = typeof body.status === "string" ? body.status : undefined;
  const content = typeof body.body === "string" ? body.body : undefined;
  if (status === undefined && content === undefined) return new Response("status or body required", { status: 400 });
  // The "done" status stamps occurred_at; reopening clears it. Other statuses leave it.
  const done = status === "done" || status === "completed" || status === "resolved";

  try {
    const row = await withUser(sess.userId, async (c) => {
      const sets: string[] = ["updated_at=now()"];
      const params: unknown[] = [id, sess.userId];
      if (status !== undefined) { params.push(status); sets.push(`status=$${params.length}`); sets.push(done ? "occurred_at=coalesce(occurred_at, now())" : "occurred_at=null"); }
      if (content !== undefined) { params.push(content); sets.push(`body=$${params.length}`); }
      const r = await c.query(
        `update eidan.events set ${sets.join(", ")} where id=$1 and user_id=$2 and deleted_at is null returning id, status`,
        params,
      );
      return r.rows[0] as Record<string, unknown> | undefined;
    });
    if (!row) return new Response("not found", { status: 404 });
    return Response.json({ event: { id: row.id, status: row.status } });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "update failed", { status: 400 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  try {
    const n = await withUser(sess.userId, async (c) => {
      const r = await c.query("update eidan.events set deleted_at=now() where id=$1 and user_id=$2 and deleted_at is null", [id, sess.userId]);
      return r.rowCount ?? 0;
    });
    if (n === 0) return new Response("not found", { status: 404 });
    return new Response(null, { status: 204 });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
