// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/me/secrets — the caller's connection catalogue (docs/031 Phase 2). Lists the vault keys
// the user has configured (values are NEVER returned). The full plugin-declared catalogue of
// possible keys is engine state; this surfaces what's actually set, RLS-scoped.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select key, max(expires_at) as expires_at
         from eidan.secrets_vault where user_id = $1
         group by key order by key`,
      [sess.userId],
    );
    return r.rows as Array<{ key: string; expires_at: unknown }>;
  });

  return Response.json({
    connections: rows.map((r) => ({
      key: r.key,
      description: r.key,
      configured: true,
      expires_at: r.expires_at ? iso(r.expires_at) : null,
    })),
  });
}
