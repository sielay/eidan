// SPDX-License-Identifier: AGPL-3.0-or-later
// GET/PUT /api/agent — the caller's primary agent config (eidan.agent_context). persona resolves
// user_overrides.system_prompt → code_defaults.system_prompt → null. PUT sets the persona override.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function toAgent(r: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!r) {
    return {
      id: "default",
      agent_slug: "eidan",
      display_name: "eidan",
      description: null,
      enabled: true,
      code_defaults: {},
      user_overrides: {},
      persona: null,
      updated_at: iso(null),
    };
  }
  const code = obj(r.code_defaults);
  const over = obj(r.user_overrides);
  const persona =
    (typeof over.system_prompt === "string" ? over.system_prompt : null) ??
    (typeof code.system_prompt === "string" ? code.system_prompt : null);
  return {
    id: r.id,
    agent_slug: r.agent_slug,
    display_name: r.display_name ?? r.agent_slug,
    description: r.description ?? null,
    enabled: r.enabled !== false,
    code_defaults: code,
    user_overrides: over,
    persona,
    updated_at: iso(r.updated_at),
  };
}

async function primary(userId: string): Promise<Record<string, unknown> | undefined> {
  return withUser(userId, async (c) => {
    const r = await c.query(
      `select id, agent_slug, display_name, description, enabled, code_defaults, user_overrides, updated_at
         from eidan.agent_context where user_id = $1 order by enabled desc, updated_at desc limit 1`,
      [userId],
    );
    return r.rows[0] as Record<string, unknown> | undefined;
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  return Response.json({ agent: toAgent(await primary(sess.userId)) });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let persona: string | null = null;
  try {
    const b = (await req.json()) as { persona?: string | null };
    persona = typeof b.persona === "string" && b.persona.trim() !== "" ? b.persona : null;
  } catch {
    /* empty body → clear */
  }

  const row = await primary(sess.userId);
  if (row) {
    await withUser(sess.userId, async (c) => {
      await c.query(
        `update eidan.agent_context
           set user_overrides = jsonb_set(coalesce(user_overrides, '{}'::jsonb), '{system_prompt}', to_jsonb($2::text), true),
               updated_at = now()
         where id = $1 and user_id = $3`,
        [row.id, persona, sess.userId],
      );
    });
  }
  return Response.json({ agent: toAgent(await primary(sess.userId)) });
}
