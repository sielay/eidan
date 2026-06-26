// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/charles/ventures/prompt — set a venture's free-text prompt (operator-authored standing
// context for the venture), owner-scoped. Mirrors the venture_set_prompt agent tool: stored under
// metadata.prompt; a blank value clears it. The Ventures screen calls this to author the context the
// agent later reads via venture_get.
//   POST { venture_id, prompt } → { ok, prompt }
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const ventureId = typeof body["venture_id"] === "string" ? body["venture_id"].trim() : "";
  if (!ventureId) return Response.json({ error: "venture_id is required" }, { status: 400 });
  if (typeof body["prompt"] !== "string") return Response.json({ error: "prompt must be a string" }, { status: 400 });
  const prompt = body["prompt"].trim();

  const outcome = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      // Set metadata.prompt when there's text, else strip the key — keeps an empty prompt out of the blob.
      prompt
        ? `update plugin_ventures.ventures
              set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{prompt}', to_jsonb($3::text), true),
                  updated_at = now()
            where id = $1 and user_id = $2 and status = 'active'
          returning metadata->>'prompt' as prompt`
        : `update plugin_ventures.ventures
              set metadata = coalesce(metadata, '{}'::jsonb) - 'prompt', updated_at = now()
            where id = $1 and user_id = $2 and status = 'active'
          returning metadata->>'prompt' as prompt`,
      prompt ? [ventureId, sess.userId, prompt] : [ventureId, sess.userId],
    );
    return r.rows[0] as { prompt: string | null } | undefined;
  });

  if (!outcome) return Response.json({ error: "no such venture" }, { status: 404 });
  return Response.json({ ok: true, prompt: outcome.prompt ?? null });
}
