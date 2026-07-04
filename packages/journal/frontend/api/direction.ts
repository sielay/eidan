// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/journal/direction — get/set the editable direction prompt (plugin_journal.settings, one row
// per user) that governs how dropped notes are categorised + routed. When unset, the engine falls
// back to its built-in default (packages/journal/src/types.ts DEFAULT_DIRECTION_PROMPT), so an empty
// value here means "default in use" rather than "no prompt".
//   GET               → { direction_prompt, is_default }
//   PUT { prompt }    → { ok, direction_prompt }   (empty/blank prompt clears the override)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const prompt = await withUser(sess.userId, async (c) => {
    const r = await c.query(`select direction_prompt from plugin_journal.settings where user_id = $1`, [sess.userId]);
    return (r.rows[0] as { direction_prompt?: string } | undefined)?.direction_prompt ?? null;
  });
  return Response.json({ direction_prompt: prompt, is_default: prompt === null });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";

  const saved = await withUser(sess.userId, async (c) => {
    if (!prompt) {
      // Blank → clear the override so the engine default applies again.
      await c.query(`delete from plugin_journal.settings where user_id = $1`, [sess.userId]);
      return null;
    }
    const r = await c.query(
      `insert into plugin_journal.settings (user_id, direction_prompt, updated_at)
       values ($1, $2, now())
       on conflict (user_id) do update set direction_prompt = excluded.direction_prompt, updated_at = now()
       returning direction_prompt`,
      [sess.userId, prompt],
    );
    return (r.rows[0] as { direction_prompt?: string } | undefined)?.direction_prompt ?? null;
  });
  return Response.json({ ok: true, direction_prompt: saved, is_default: saved === null });
}
