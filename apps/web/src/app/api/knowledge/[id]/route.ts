// SPDX-License-Identifier: AGPL-3.0-or-later
// GET / PATCH / DELETE /api/knowledge/[id] — read a knowledge row (with body), edit it, or
// soft-delete it. The Memory/Knowledge browser renders the body as markdown and edits it inline.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function detail(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug ?? null,
    title: row.title ?? null,
    skill: row.skill ?? null,
    body: row.body ?? "",
    source: row.source ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

const COLS = "id, slug, title, skill, body, source, created_at, updated_at";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  try {
    const row = await withUser(sess.userId, async (c) => {
      const r = await c.query(`select ${COLS} from eidan.knowledge where id=$1 and user_id=$2 and deleted_at is null`, [id, sess.userId]);
      return r.rows[0] as Record<string, unknown> | undefined;
    });
    if (!row) return new Response("not found", { status: 404 });
    return Response.json({ knowledge: detail(row) });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;

  let payload: { title?: string; body?: string; skill?: string; expected_updated_at?: string };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  try {
    const result = await withUser(sess.userId, async (c) => {
      // Optimistic concurrency: when the client sends expected_updated_at, only update if the row
      // hasn't changed since they loaded it. Compare at millisecond precision (the ISO the GET
      // returns), so a clean round-trip matches but a concurrent edit (newer updated_at) does not.
      const params: unknown[] = [id, sess.userId, payload.title ?? null, payload.body ?? null, payload.skill ?? null];
      let guard = "";
      if (payload.expected_updated_at) {
        params.push(payload.expected_updated_at);
        guard = ` and date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $6::timestamptz)`;
      }
      const r = await c.query(
        `update eidan.knowledge
            set title = coalesce($3, title),
                body  = coalesce($4, body),
                skill = coalesce($5, skill),
                updated_at = now()
          where id=$1 and user_id=$2 and deleted_at is null${guard}
          returning ${COLS}`,
        params,
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (row) return { row };
      // 0 rows updated: distinguish a stale-edit conflict (row still exists) from a deleted row.
      const exists = await c.query("select 1 from eidan.knowledge where id=$1 and user_id=$2 and deleted_at is null", [id, sess.userId]);
      return { conflict: (exists.rowCount ?? 0) > 0 };
    });
    if ("row" in result && result.row) return Response.json({ knowledge: detail(result.row) });
    if ("conflict" in result && result.conflict) return new Response("conflict", { status: 409 });
    return new Response("not found", { status: 404 });
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
      const r = await c.query("update eidan.knowledge set deleted_at=now() where id=$1 and user_id=$2 and deleted_at is null", [id, sess.userId]);
      return r.rowCount ?? 0;
    });
    if (n === 0) return new Response("not found", { status: 404 });
    return new Response(null, { status: 204 });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
