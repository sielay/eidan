// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/usage/agents — per-agent activity: runs, tokens, and cost over the date range.
// Mirrors the engine `observer` tool (agent_activity) but scoped to the requesting user, so the
// admin Usage pane can show where tokens go by agent. Cost is the stored cost_usd (pricing-correct).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const startDate = req.nextUrl.searchParams.get("start_date") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const endDate = req.nextUrl.searchParams.get("end_date") ?? new Date().toISOString().split("T")[0];

  const rows = await withUser(sess.userId, async (c) => {
    const res = await c.query(
      `with runs as (
         select agent_id, count(*)::int as run_count, max(created_at) as last_run
         from eidan.agent_runs
         where user_id = $1
           and created_at >= $2::timestamp and created_at < ($3::date + interval '1 day')
         group by agent_id
       ),
       toks as (
         select agent_id,
           coalesce(sum(input_tokens), 0)::bigint as input_tokens,
           coalesce(sum(output_tokens), 0)::bigint as output_tokens,
           coalesce(sum(cache_read_tokens), 0)::bigint as cache_read_tokens,
           coalesce(sum(cache_creation_tokens), 0)::bigint as cache_creation_tokens,
           coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0)::bigint as total_tokens,
           coalesce(sum(cost_usd), 0)::numeric as cost_usd,
           count(*)::int as call_count
         from eidan.llm_calls
         where user_id = $1
           and started_at >= $2::timestamp and started_at < ($3::date + interval '1 day')
           and agent_id is not null
         group by agent_id
       )
       select a.id as agent_id, a.name as agent_name, a.model,
         r.run_count,
         coalesce(t.input_tokens, 0)::bigint as input_tokens,
         coalesce(t.output_tokens, 0)::bigint as output_tokens,
         coalesce(t.cache_read_tokens, 0)::bigint as cache_read_tokens,
         coalesce(t.cache_creation_tokens, 0)::bigint as cache_creation_tokens,
         coalesce(t.total_tokens, 0)::bigint as total_tokens,
         coalesce(t.cost_usd, 0)::numeric as cost_usd,
         coalesce(t.call_count, 0)::int as call_count,
         r.last_run
       from eidan.agents a
       join runs r on r.agent_id = a.id
       left join toks t on t.agent_id = a.id
       where a.user_id = $1 and a.deleted_at is null
       order by cost_usd desc, total_tokens desc`,
      [sess.userId, startDate, endDate],
    );
    return res.rows;
  });

  return Response.json({
    agents: (rows as Array<Record<string, unknown>>).map((r) => ({
      agent_id: String(r.agent_id),
      agent_name: String(r.agent_name),
      model: r.model == null ? null : String(r.model),
      run_count: Number(r.run_count ?? 0),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
      cache_read_tokens: Number(r.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(r.cache_creation_tokens ?? 0),
      total_tokens: Number(r.total_tokens ?? 0),
      cost_usd: Number(r.cost_usd ?? 0),
      call_count: Number(r.call_count ?? 0),
      last_run: r.last_run == null ? null : new Date(r.last_run as string).toISOString(),
    })),
  });
}
