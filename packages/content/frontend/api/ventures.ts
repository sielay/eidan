// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/content/ventures — the venture tree, for the brand-scope picker. Read-only over
// plugin_ventures.ventures (another plugin's schema; the web tier reads the operator's DB broadly).
// Guarded: if the ventures plugin isn't installed, returns an empty list rather than erroring.
//   GET → { ventures: [{ id, name, slug, parent_id }] }  (parents before children)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VentureLite { id: string; name: string; slug: string; parent_id: string | null }

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const ventures = await withUser(sess.userId, async (c) => {
    try {
      const r = await c.query(
        `select id, name, slug, parent_id from plugin_ventures.ventures
           where user_id = $1 and status = 'active' order by parent_id nulls first, name`,
        [sess.userId],
      );
      return r.rows as VentureLite[];
    } catch {
      return [] as VentureLite[]; // ventures plugin not installed
    }
  });
  return Response.json({ ventures });
}
