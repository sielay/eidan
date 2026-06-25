// SPDX-License-Identifier: AGPL-3.0-or-later
// PATCH  /api/admin/agents/:id — update an agent (enabled toggle + field edits).
// DELETE /api/admin/agents/:id — soft-delete an agent (its triggers cascade out of the dispatch scan).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ detail: "invalid JSON body" }, { status: 400 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (typeof body.name === "string" && body.name.trim()) { sets.push(`name = $${i++}`); vals.push(body.name.trim()); }
  if (typeof body.persona === "string" && body.persona.trim()) { sets.push(`persona = $${i++}`); vals.push(body.persona.trim()); }
  if (body.provider !== undefined) { sets.push(`provider = $${i++}`); vals.push(typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : null); }
  if (body.model !== undefined) { sets.push(`model = $${i++}`); vals.push(typeof body.model === "string" && body.model.trim() ? body.model.trim() : null); }
  if (body.target_node !== undefined) { sets.push(`target_node = $${i++}`); vals.push(typeof body.target_node === "string" && body.target_node.trim() ? body.target_node.trim() : null); }
  if (typeof body.enabled === "boolean") { sets.push(`enabled = $${i++}`); vals.push(body.enabled); }
  if (body.avatar !== undefined) { sets.push(`metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{avatar}', $${i++}::jsonb, true)`); vals.push(JSON.stringify(body.avatar ?? {})); }
  if (sets.length === 0) return Response.json({ detail: "nothing to update" }, { status: 400 });

  vals.push(id, sess.userId);
  const ok = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update eidan.agents set ${sets.join(", ")}
        where id = $${i++} and user_id = $${i} and deleted_at is null`,
      vals,
    );
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) return Response.json({ detail: "no such agent" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  const ok = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update eidan.agents set deleted_at = now() where id = $1 and user_id = $2 and deleted_at is null`,
      [id, sess.userId],
    );
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) return Response.json({ detail: "no such agent" }, { status: 404 });
  return Response.json({ ok: true });
}
