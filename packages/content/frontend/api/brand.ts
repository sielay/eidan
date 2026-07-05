// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/content/brand — read/write the default brand kit (Surface B: Next-reads-Postgres, owner-scoped
// over plugin_content.brand_kits via RLS). The brand kit grounds every content generation; the agent
// also reads/writes it via the brand_kit tool. This panel edits the 'default' scope.
//   GET            → { brand }
//   PUT { voice?, styleguide?, language? } → { ok, brand }  (partial — only named fields change)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

const SCOPE = "default";
interface BrandRow { voice: string | null; styleguide: string | null; language: string | null }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const brand = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select voice, styleguide, language from plugin_content.brand_kits where user_id = $1 and scope = $2`,
      [sess.userId, SCOPE],
    );
    return (r.rows[0] as BrandRow | undefined) ?? { voice: null, styleguide: null, language: null };
  });
  return Response.json({ brand });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  const sets: string[] = [];
  const vals: unknown[] = [sess.userId, SCOPE];
  const put = (col: string, key: string): void => {
    if (typeof body[key] === "string") { vals.push((body[key] as string).trim() || null); sets.push(`${col} = $${vals.length}`); }
  };
  put("voice", "voice"); put("styleguide", "styleguide"); put("language", "language");
  if (!sets.length) return Response.json({ error: "nothing to update" }, { status: 400 });

  const brand = await withUser(sess.userId, async (c) => {
    // Ensure a row exists (insert-if-absent), then patch only the provided columns.
    await c.query(
      `insert into plugin_content.brand_kits (user_id, scope) values ($1, $2) on conflict (user_id, scope) do nothing`,
      [sess.userId, SCOPE],
    );
    const r = await c.query(
      `update plugin_content.brand_kits set ${sets.join(", ")}, updated_at = now() where user_id = $1 and scope = $2
       returning voice, styleguide, language`,
      vals,
    );
    return (r.rows[0] as BrandRow | undefined) ?? { voice: null, styleguide: null, language: null };
  });
  return Response.json({ ok: true, brand });
}
