// SPDX-License-Identifier: AGPL-3.0-or-later
// GET / PATCH / DELETE /api/notes/[id] — read a note's raw content, edit it, or soft-delete it.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  try {
    const row = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        "select id, content, metadata, created_at, updated_at from eidan.notes where id=$1 and user_id=$2 and deleted_at is null",
        [id, sess.userId],
      );
      return r.rows[0] as Record<string, unknown> | undefined;
    });
    if (!row) return new Response("not found", { status: 404 });
    return Response.json({
      note: {
        id: row.id,
        content: row.content ?? "",
        metadata: (row.metadata as Record<string, unknown> | null) ?? {},
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;

  let body: { content?: unknown; pinned?: unknown };
  try {
    body = (await req.json()) as { content?: unknown; pinned?: unknown };
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : undefined;
  const pinned = typeof body.pinned === "boolean" ? body.pinned : undefined;
  if (content === undefined && pinned === undefined) return new Response("content or pinned required", { status: 400 });

  try {
    const row = await withUser(sess.userId, async (c) => {
      const sets: string[] = ["updated_at=now()"];
      const params: unknown[] = [id, sess.userId];
      if (content !== undefined) { params.push(content); sets.push(`content=$${params.length}`); }
      if (pinned !== undefined) { params.push(JSON.stringify(pinned)); sets.push(`metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{pinned}', $${params.length}::jsonb, true)`); }
      const r = await c.query(
        `update eidan.notes set ${sets.join(", ")} where id=$1 and user_id=$2 and deleted_at is null returning id, content, updated_at`,
        params,
      );
      return r.rows[0] as Record<string, unknown> | undefined;
    });
    if (!row) return new Response("not found", { status: 404 });
    return Response.json({ note: { id: row.id, content: row.content ?? "", updated_at: iso(row.updated_at) } });
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
      const r = await c.query("update eidan.notes set deleted_at=now() where id=$1 and user_id=$2 and deleted_at is null", [id, sess.userId]);
      return r.rowCount ?? 0;
    });
    if (n === 0) return new Response("not found", { status: 404 });
    return new Response(null, { status: 204 });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
