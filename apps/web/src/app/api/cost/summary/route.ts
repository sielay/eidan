// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/cost/summary?scope=turn|session|day[&message_id=…] — token-cost rollup from
// eidan.llm_calls (docs/010 §6). turn = a single message; session = since the JWT iat; day = 24h.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES = new Set(["turn", "session", "day"]);

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const raw = req.nextUrl.searchParams.get("scope") ?? "day";
  const scope = SCOPES.has(raw) ? raw : "day";
  const messageId = req.nextUrl.searchParams.get("message_id");
  // Without a message_id, `message_id = NULL` matches nothing and would return a misleading $0.
  if (scope === "turn" && !messageId) {
    return new Response("scope=turn requires message_id", { status: 400 });
  }

  const row = await withUser(sess.userId, async (c) => {
    const params: unknown[] = [sess.userId];
    let where = "user_id = $1";
    if (scope === "turn") {
      where += " and message_id = $2";
      params.push(messageId);
    } else if (scope === "session") {
      where += " and started_at >= to_timestamp($2)";
      params.push(sess.iat);
    } else {
      where += " and started_at >= now() - interval '24 hours'";
    }
    const r = await c.query(
      `select coalesce(sum(cost_usd), 0) as cost,
              coalesce(sum(input_tokens), 0) as inp,
              coalesce(sum(output_tokens), 0) as outp
         from eidan.llm_calls where ${where}`,
      params,
    );
    return r.rows[0] as { cost: string; inp: string; outp: string };
  });

  return Response.json({
    scope,
    cost_usd: Number(row.cost),
    input_tokens: Number(row.inp),
    output_tokens: Number(row.outp),
  });
}
