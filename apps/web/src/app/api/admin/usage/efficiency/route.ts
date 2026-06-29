// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/usage/efficiency — deterministic optimisation flags over the date range.
// Mirrors the engine `observer` tool (efficiency_flags), user-scoped for the admin Usage pane:
//   high_cost_agents — pricey model doing below-average work (downgrade candidate)
//   logging_gaps     — agents with runs but no LLM calls logged (tool-only, or ledger not wired)
//   cache_misses     — provider/model with high input:output and little cache read (enable caching)
// No LLM inference — pure SQL + comparison logic, safe to poll.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRICEY = /opus|sonnet|gpt-4o(?!-mini)/i;

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const startDate = req.nextUrl.searchParams.get("start_date") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const endDate = req.nextUrl.searchParams.get("end_date") ?? new Date().toISOString().split("T")[0];

  const { agents, models } = await withUser(sess.userId, async (c) => {
    const agentsRes = await c.query(
      `with runs as (
         select agent_id, count(*)::int as run_count
         from eidan.agent_runs
         where user_id = $1
           and created_at >= $2::timestamp and created_at < ($3::date + interval '1 day')
         group by agent_id
       ),
       toks as (
         select agent_id,
           coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0)::bigint as total_tokens,
           coalesce(sum(cost_usd), 0)::numeric as cost_usd
         from eidan.llm_calls
         where user_id = $1
           and started_at >= $2::timestamp and started_at < ($3::date + interval '1 day')
           and agent_id is not null
         group by agent_id
       )
       select a.name as agent_name, a.model, r.run_count,
         coalesce(t.total_tokens, 0)::bigint as total_tokens,
         coalesce(t.cost_usd, 0)::numeric as cost_usd
       from eidan.agents a
       join runs r on r.agent_id = a.id
       left join toks t on t.agent_id = a.id
       where a.user_id = $1 and a.deleted_at is null`,
      [sess.userId, startDate, endDate],
    );
    const modelsRes = await c.query(
      `select provider, model,
         coalesce(sum(input_tokens), 0)::bigint as input_tokens,
         coalesce(sum(output_tokens), 0)::bigint as output_tokens,
         coalesce(sum(cache_read_tokens), 0)::bigint as cache_read_tokens,
         coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0)::bigint as total_tokens
       from eidan.llm_calls
       where user_id = $1
         and started_at >= $2::timestamp and started_at < ($3::date + interval '1 day')
       group by provider, model`,
      [sess.userId, startDate, endDate],
    );
    return { agents: agentsRes.rows, models: modelsRes.rows };
  });

  const agentRows = (agents as Array<Record<string, unknown>>).map((r) => ({
    agent_name: String(r.agent_name),
    model: r.model == null ? "" : String(r.model),
    run_count: Number(r.run_count ?? 0),
    total_tokens: Number(r.total_tokens ?? 0),
    cost_usd: Number(r.cost_usd ?? 0),
  }));
  const avgTokens = agentRows.length
    ? agentRows.reduce((s, a) => s + a.total_tokens, 0) / agentRows.length
    : 0;

  const high_cost_agents = agentRows
    .filter((a) => PRICEY.test(a.model) && a.total_tokens > 0 && a.total_tokens < avgTokens * 0.5)
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, 10)
    .map((a) => ({
      name: a.agent_name,
      model: a.model,
      tokens: a.total_tokens,
      cost_usd: Math.round(a.cost_usd * 10000) / 10000,
      reason: "pricey model doing below-average work — candidate to downgrade (e.g. to haiku)",
    }));

  const logging_gaps = agentRows
    .filter((a) => a.run_count > 0 && a.total_tokens === 0)
    .slice(0, 10)
    .map((a) => ({
      agent: a.agent_name,
      run_count: a.run_count,
      reason: "runs recorded but no LLM calls logged — tool-only run, or the call ledger is not wired",
    }));

  const cache_misses = (models as Array<Record<string, unknown>>)
    .map((r) => ({
      provider: String(r.provider),
      model: String(r.model),
      input: Number(r.input_tokens ?? 0),
      output: Number(r.output_tokens ?? 0),
      cacheRead: Number(r.cache_read_tokens ?? 0),
      total: Number(r.total_tokens ?? 0),
    }))
    .filter((b) => {
      if (b.output <= 0) return false;
      const cacheHit = b.total > 0 ? b.cacheRead / b.total : 0;
      return b.input > b.output * 1.5 && cacheHit < 0.1;
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((b) => ({
      provider: b.provider,
      model: b.model,
      tokens: b.total,
      input_output_ratio: b.output > 0 ? Math.round((b.input / b.output) * 100) / 100 : 0,
      reason: "high input:output with little cache read — enable/extend prompt caching",
    }));

  return Response.json({ high_cost_agents, logging_gaps, cache_misses });
}
