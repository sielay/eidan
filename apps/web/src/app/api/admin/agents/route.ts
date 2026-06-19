// SPDX-License-Identifier: AGPL-3.0-or-later
// GET  /api/admin/agents — the operator's agents (eidan.agents) with their triggers + recent fires.
// POST /api/admin/agents — create an agent (+ an optional schedule trigger in one call).
// Direct Postgres (verifyBearer + withUser), mirroring the routines/jobs admin routes. Agents are the
// generalised proactive primitive (epic #346): a persona + its own provider, run by composable triggers.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";
import { isValidSchedule } from "@/lib/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select a.id, a.name, a.persona, a.provider, a.model, a.target_node, a.enabled, a.created_at,
              coalesce(tg.triggers, '[]'::json)   as triggers,
              coalesce(rn.recent_runs, '[]'::json) as recent_runs
         from eidan.agents a
         left join lateral (
           select json_agg(json_build_object(
                    'id', t.id, 'type', t.type, 'config', t.config, 'enabled', t.enabled
                  ) order by t.created_at) as triggers
             from eidan.agent_triggers t where t.agent_id = a.id and t.deleted_at is null
         ) tg on true
         left join lateral (
           select json_agg(json_build_object(
                    'fire_key', r.fire_key, 'status', r.status,
                    'conversation_id', r.conversation_id, 'detail', r.detail, 'created_at', r.created_at
                  ) order by r.created_at desc) as recent_runs
             from (
               select fire_key, status, conversation_id, detail, created_at
                 from eidan.agent_runs where agent_id = a.id order by created_at desc limit 5
             ) r
         ) rn on true
        where a.user_id = $1 and a.deleted_at is null
        order by a.created_at desc`,
      [sess.userId],
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    agents: rows.map((a) => ({
      id: a.id,
      name: a.name,
      persona: a.persona ?? "",
      provider: a.provider ?? null,
      model: a.model ?? null,
      target_node: a.target_node ?? null,
      enabled: Boolean(a.enabled),
      created_at: iso(a.created_at),
      triggers: ((a.triggers as Array<Record<string, unknown>> | null) ?? []).map((t) => ({
        id: String(t.id),
        type: String(t.type),
        config: (t.config as Record<string, unknown>) ?? {},
        enabled: Boolean(t.enabled),
      })),
      recent_runs: ((a.recent_runs as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
        fire_key: String(r.fire_key ?? ""),
        status: String(r.status ?? ""),
        conversation_id: r.conversation_id ? String(r.conversation_id) : null,
        detail: r.detail == null ? null : String(r.detail),
        created_at: iso(r.created_at),
      })),
    })),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ detail: "invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const persona = typeof body.persona === "string" ? body.persona.trim() : "";
  const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  const targetNode = typeof body.target_node === "string" && body.target_node.trim() ? body.target_node.trim() : null;
  const schedule = typeof body.schedule === "string" && body.schedule.trim() ? body.schedule.trim() : null;
  if (!name || !persona) return Response.json({ detail: "name and persona are required" }, { status: 400 });
  if (schedule && !isValidSchedule(schedule)) {
    return Response.json({ detail: `invalid schedule "${schedule}"` }, { status: 400 });
  }

  const id = await withUser(sess.userId, async (c) => {
    const a = await c.query(
      `insert into eidan.agents (user_id, name, persona, provider, model, target_node)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [sess.userId, name, persona, provider, model, targetNode],
    );
    const agentId = a.rows[0]?.id as string;
    if (schedule) {
      await c.query(
        `insert into eidan.agent_triggers (agent_id, user_id, type, config)
         values ($1, $2, 'schedule', $3::jsonb)`,
        [agentId, sess.userId, JSON.stringify({ schedule })],
      );
    }
    return agentId;
  });

  return Response.json({ id }, { status: 201 });
}
