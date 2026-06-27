// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/usage/summary — total costs/tokens over a time window
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GroupBy = "model" | "provider" | "node" | "role";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const startDate = req.nextUrl.searchParams.get("start_date") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const endDate = req.nextUrl.searchParams.get("end_date") ?? new Date().toISOString().split("T")[0];
  const groupByParam = (req.nextUrl.searchParams.get("group_by") ?? "provider") as GroupBy;

  const groupByCols: Record<GroupBy, string> = {
    model: "model",
    provider: "provider",
    node: "metadata->>'node_id'",
    role: "role",
  };

  const groupByCol = groupByCols[groupByParam] ?? groupByCols.provider;

  const data = await withUser(sess.userId, async (c) => {
    const summary = await c.query(
      `select
        coalesce(sum(cost_usd), 0) as total_cost_usd,
        coalesce(sum(input_tokens), 0)::int as total_input_tokens,
        coalesce(sum(output_tokens), 0)::int as total_output_tokens,
        coalesce(sum(cache_read_tokens), 0)::int as total_cache_read_tokens,
        coalesce(sum(cache_creation_tokens), 0)::int as total_cache_creation_tokens
       from eidan.llm_calls
      where user_id=$1 and started_at >= $2::timestamp and started_at < ($3::date + interval '1 day')`,
      [sess.userId, startDate, endDate],
    );

    const byGroup = await c.query(
      `select
        ${groupByCol} as group_key,
        coalesce(sum(cost_usd), 0)::numeric as cost_usd,
        coalesce(sum(input_tokens), 0)::int as input_tokens,
        coalesce(sum(output_tokens), 0)::int as output_tokens,
        coalesce(sum(cache_read_tokens), 0)::int as cache_read_tokens,
        coalesce(sum(cache_creation_tokens), 0)::int as cache_creation_tokens,
        count(*)::int as call_count
       from eidan.llm_calls
      where user_id=$1 and started_at >= $2::timestamp and started_at < ($3::date + interval '1 day')
      group by ${groupByCol}
      order by cost_usd desc`,
      [sess.userId, startDate, endDate],
    );

    return { summary: summary.rows[0], byGroup: byGroup.rows };
  });

  const s = (data.summary as Record<string, unknown>) ?? {};
  return Response.json({
    total_cost_usd: Number(s.total_cost_usd ?? 0),
    total_input_tokens: Number(s.total_input_tokens ?? 0),
    total_output_tokens: Number(s.total_output_tokens ?? 0),
    total_cache_read_tokens: Number(s.total_cache_read_tokens ?? 0),
    total_cache_creation_tokens: Number(s.total_cache_creation_tokens ?? 0),
    by_group: (data.byGroup as Array<Record<string, unknown>>).map((row) => ({
      group: String(row.group_key),
      cost_usd: Number(row.cost_usd ?? 0),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      cache_read_tokens: Number(row.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(row.cache_creation_tokens ?? 0),
      call_count: Number(row.call_count ?? 0),
    })),
  });
}
