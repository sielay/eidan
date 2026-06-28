// SPDX-License-Identifier: AGPL-3.0-or-later
// POST   /api/admin/agents/:id/triggers          — add a schedule trigger to an agent.
// DELETE /api/admin/agents/:id/triggers?trigger_id — remove a trigger (any type).
// This route is specifically for schedule triggers. decision_gate and other trigger
// types would require separate endpoints or a refactored generic trigger creation flow.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";
import { isValidSchedule } from "@/lib/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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
  const schedule = typeof body.schedule === "string" ? body.schedule.trim() : "";
  if (!schedule || !isValidSchedule(schedule)) {
    return Response.json({ detail: `invalid schedule "${schedule}"` }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";

  const ok = await withUser(sess.userId, async (c) => {
    const a = await c.query(
      `select id from eidan.agents where id = $1 and user_id = $2 and deleted_at is null`,
      [id, sess.userId],
    );
    if ((a.rowCount ?? 0) === 0) return false;
    const config: Record<string, unknown> = { schedule };
    if (model) config.model = model;
    await c.query(
      `insert into eidan.agent_triggers (agent_id, user_id, type, config)
       values ($1, $2, $3, $4::jsonb)`,
      [id, sess.userId, "schedule", JSON.stringify(config)],
    );
    return true;
  });
  if (!ok) return Response.json({ detail: "no such agent" }, { status: 404 });
  return Response.json({ ok: true }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id } = await params;
  const triggerId = req.nextUrl.searchParams.get("trigger_id");
  if (!triggerId) return Response.json({ detail: "trigger_id is required" }, { status: 400 });

  const ok = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update eidan.agent_triggers set deleted_at = now()
        where id = $1 and agent_id = $2 and user_id = $3 and deleted_at is null`,
      [triggerId, id, sess.userId],
    );
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) return Response.json({ detail: "no such trigger" }, { status: 404 });
  return Response.json({ ok: true });
}
