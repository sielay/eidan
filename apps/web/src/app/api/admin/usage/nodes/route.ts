// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/usage/nodes — per-node breakdown (multi-node awareness)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OrderBy = "cost" | "count" | "tokens";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const startDate = req.nextUrl.searchParams.get("start_date") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const endDate = req.nextUrl.searchParams.get("end_date") ?? new Date().toISOString().split("T")[0];
  const orderByParam = (req.nextUrl.searchParams.get("order_by") ?? "cost") as OrderBy;

  const orderByClauses: Record<OrderBy, string> = {
    cost: "cost_usd desc",
    count: "call_count desc",
    tokens: "(input_tokens + output_tokens) desc",
  };
  const orderByClause = orderByClauses[orderByParam] ?? orderByClauses.cost;

  const data = await withUser(sess.userId, async (c) => {
    return await c.query(
      `select
        coalesce(metadata->>'node_id', 'unknown') as node_id,
        coalesce(sum(cost_usd), 0)::numeric as cost_usd,
        coalesce(sum(input_tokens), 0)::int as input_tokens,
        coalesce(sum(output_tokens), 0)::int as output_tokens,
        coalesce(sum(cache_read_tokens), 0)::int as cache_read_tokens,
        coalesce(sum(cache_creation_tokens), 0)::int as cache_creation_tokens,
        count(*)::int as call_count
       from eidan.llm_calls
      where user_id=$1 and started_at >= $2::timestamp and started_at < ($3::date + interval '1 day')
      group by node_id
      order by ${orderByClause}`,
      [sess.userId, startDate, endDate],
    );
  });

  return Response.json({
    nodes: (data.rows as Array<Record<string, unknown>>).map((row) => ({
      node_id: String(row.node_id),
      cost_usd: Number(row.cost_usd ?? 0),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      cache_read_tokens: Number(row.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(row.cache_creation_tokens ?? 0),
      call_count: Number(row.call_count ?? 0),
    })),
  });
}
