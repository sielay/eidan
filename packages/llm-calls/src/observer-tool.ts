// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import type { Db } from './db.js';

// Model & Cache Observer: read-only aggregations over the cost/usage ledger this plugin owns
// (eidan.llm_calls) joined with eidan.agent_runs/eidan.agents. These are NOT procedures
// (agent-authored sandboxed JS, eidan.procedures) — they are deterministic, code-shipped tools so
// the observability dashboard/agent gets the same numbers every run without burning a turn writing
// SQL. Cost is read from the stored cost_usd column (computed once in pricing.ts at record time),
// not re-derived here, so the rollups always match the ledger.

const ACTIONS = ['token_summary', 'agent_activity', 'cost_breakdown', 'efficiency_flags'] as const;
type Action = (typeof ACTIONS)[number];

const DESCRIPTION = [
  'Model & Cache Observer: deterministic, read-only rollups over the LLM cost/usage ledger',
  '(eidan.llm_calls + agent_runs). No LLM inference — pure SQL aggregation, safe to poll or schedule.',
  '',
  'Actions (TypeScript union); every action accepts an optional `window_hours` (default 24, max 720):',
  "  { action: 'token_summary'; window_hours?: number }    // tokens by provider/model: calls, input/output/cache, total",
  "  { action: 'agent_activity'; window_hours?: number }   // per-agent runs, tokens and cost, last run time",
  "  { action: 'cost_breakdown'; window_hours?: number }   // USD cost by provider/model (from stored cost_usd) + monthly projection",
  "  { action: 'efficiency_flags'; window_hours?: number } // optimisation flags: pricey-model/low-work, logging gaps, low cache-hit",
  '',
  'Prefer this tool over hand-written SQL or a procedure for these four questions — it owns the',
  'pricing-correct numbers and is stable across runs.',
].join('\n');

function windowHours(input: unknown): number {
  const raw = (input as { window_hours?: unknown } | null)?.window_hours;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(Math.floor(n), 720);
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

async function tokenSummary(db: Db, hours: number): Promise<unknown> {
  const { rows } = await db.query(
    `select provider, model,
       count(*)::int as call_count,
       coalesce(sum(input_tokens),0)::bigint as total_input,
       coalesce(sum(output_tokens),0)::bigint as total_output,
       coalesce(sum(cache_read_tokens),0)::bigint as total_cache_read,
       coalesce(sum(cache_creation_tokens),0)::bigint as total_cache_write,
       coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0)::bigint as total_tokens
     from eidan.llm_calls
     where created_at > now() - make_interval(hours => $1)
     group by provider, model
     order by total_tokens desc`,
    [hours],
  );
  let totalCalls = 0;
  let totalTokens = 0;
  const breakdown = rows.map((r) => {
    const callCount = num(r.call_count);
    const totalTok = num(r.total_tokens);
    totalCalls += callCount;
    totalTokens += totalTok;
    return {
      provider: r.provider,
      model: r.model,
      call_count: callCount,
      total_input: num(r.total_input),
      total_output: num(r.total_output),
      total_cache_read: num(r.total_cache_read),
      total_cache_write: num(r.total_cache_write),
      total_tokens: totalTok,
      avg_per_call: callCount > 0 ? Math.round((totalTok / callCount) * 100) / 100 : 0,
    };
  });
  return { window_hours: hours, total_calls: totalCalls, total_tokens: totalTokens, breakdown };
}

async function agentActivity(db: Db, hours: number): Promise<unknown> {
  const { rows } = await db.query(
    `with runs as (
       select agent_id, count(*)::int as run_count, max(created_at) as last_run
       from eidan.agent_runs
       where created_at > now() - make_interval(hours => $1)
       group by agent_id
     ),
     toks as (
       select agent_id,
         coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0)::bigint as total_tokens,
         coalesce(sum(cost_usd),0)::numeric as cost_usd
       from eidan.llm_calls
       where created_at > now() - make_interval(hours => $1) and agent_id is not null
       group by agent_id
     )
     select a.name as agent_name, a.model,
       r.run_count,
       coalesce(t.total_tokens,0)::bigint as total_tokens,
       coalesce(t.cost_usd,0)::numeric as cost_usd,
       r.last_run
     from eidan.agents a
     join runs r on r.agent_id = a.id
     left join toks t on t.agent_id = a.id
     where a.deleted_at is null
     order by total_tokens desc`,
    [hours],
  );
  let totalRuns = 0;
  const agentsActive = rows.map((r) => {
    totalRuns += num(r.run_count);
    return {
      agent_name: r.agent_name,
      model: r.model ?? 'unset',
      run_count: num(r.run_count),
      total_tokens: num(r.total_tokens),
      cost_usd: Math.round(num(r.cost_usd) * 10000) / 10000,
      last_run: r.last_run,
    };
  });
  return { window_hours: hours, total_runs: totalRuns, agents_active: agentsActive };
}

async function costBreakdown(db: Db, hours: number): Promise<unknown> {
  const { rows } = await db.query(
    `select provider, model,
       coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0)::bigint as total_tokens,
       coalesce(sum(cost_usd),0)::numeric as cost_usd
     from eidan.llm_calls
     where created_at > now() - make_interval(hours => $1)
     group by provider, model
     order by cost_usd desc`,
    [hours],
  );
  let totalCost = 0;
  const providers = rows.map((r) => {
    const cost = num(r.cost_usd);
    totalCost += cost;
    return {
      provider: r.provider,
      model: r.model,
      tokens: num(r.total_tokens),
      estimated_cost_usd: Math.round(cost * 10000) / 10000,
    };
  });
  const totalCostUsd = Math.round(totalCost * 10000) / 10000;
  // Scale the observed window up to a 30-day month so projections are comparable across window sizes.
  // This assumes constant usage rate across the month; bursty/seasonal patterns will differ.
  const monthlyProjection = Math.round((totalCost / hours) * 24 * 30 * 100) / 100;
  return {
    window_hours: hours,
    providers,
    total_cost_usd: totalCostUsd,
    monthly_projection_usd: monthlyProjection,
  };
}

async function efficiencyFlags(db: Db, hours: number): Promise<unknown> {
  // Note: this function independently calls agentActivity() and tokenSummary() to compute flags.
  // If the agent calls these actions sequentially in the same turn (token_summary → agent_activity → efficiency_flags),
  // each call will recompute from the database. This is acceptable for <500ms per action, and keeps each
  // action independently callable (stateless). Future optimization: if sequential calls become a bottleneck,
  // the executor could cache intermediate results and pass them here.
  const agents = (await agentActivity(db, hours)) as {
    agents_active: { agent_name: string; model: string; run_count: number; total_tokens: number }[];
  };
  const tokens = (await tokenSummary(db, hours)) as {
    breakdown: { provider: string; model: string; total_input: number; total_output: number; total_cache_read: number; total_tokens: number }[];
  };

  const active = agents.agents_active;
  const avgTokens = active.length
    ? active.reduce((s, a) => s + a.total_tokens, 0) / active.length
    : 0;

  const pricey = /opus|sonnet|gpt-4o(?!-mini)/i;
  // Flag agents using expensive models (opus, sonnet, gpt-4o) but consuming <50% of the average tokens.
  // This heuristic identifies cases where a cheaper model (haiku) might be sufficient.
  // Note: low-token agents on pricey models may legitimately need that model for critical quality
  // work, so this is a candidate for review, not a hard recommendation.
  const high_cost_agents = active
    .filter((a) => pricey.test(a.model) && a.total_tokens > 0 && a.total_tokens < avgTokens * 0.5)
    .slice(0, 10)
    .map((a) => ({
      name: a.agent_name,
      model: a.model,
      tokens: a.total_tokens,
      reason: 'potentially inefficient: pricey model on relatively low token volume — review for downgrade feasibility',
    }));

  const logging_gaps = active
    .filter((a) => a.run_count > 0 && a.total_tokens === 0)
    .slice(0, 10)
    .map((a) => ({
      agent: a.agent_name,
      run_count: a.run_count,
      reason: 'runs recorded but no LLM calls logged — tool-only run, or the call ledger is not wired',
    }));

  const cache_misses = tokens.breakdown
    .filter((b) => {
      if (b.total_output <= 0) return false;
      const cacheHit = b.total_tokens > 0 ? b.total_cache_read / b.total_tokens : 0;
      // Flag models where input tokens are ≥1.5x output tokens AND cache hit rate <10%.
      // High input:output suggests repetitive prompts; low cache usage suggests caching is not enabled/effective.
      return b.total_input > b.total_output * 1.5 && cacheHit < 0.1;
    })
    .slice(0, 10)
    .map((b) => ({
      provider: b.provider,
      model: b.model,
      tokens: b.total_tokens,
      input_output_ratio: b.total_output > 0 ? Math.round((b.total_input / b.total_output) * 100) / 100 : 0,
      reason: 'high input:output with little cache read — enable/extend prompt caching',
    }));

  return { window_hours: hours, high_cost_agents, logging_gaps, cache_misses };
}

export function observerTool(db: Db): Tool {
  return {
    name: 'observer',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS as unknown as string[], description: ACTIONS.join(' | ') },
        window_hours: { type: 'number', description: 'look-back window in hours (default 24, max 720)' },
      },
    },
    executor: {
      async *execute(input) {
        const action = (input as { action?: string } | null)?.action as Action | undefined;
        const hours = windowHours(input);
        try {
          switch (action) {
            case 'token_summary':    yield { type: 'result', value: await tokenSummary(db, hours) }; return;
            case 'agent_activity':   yield { type: 'result', value: await agentActivity(db, hours) }; return;
            case 'cost_breakdown':   yield { type: 'result', value: await costBreakdown(db, hours) }; return;
            case 'efficiency_flags': yield { type: 'result', value: await efficiencyFlags(db, hours) }; return;
            default:
              yield { type: 'error', message: `unknown action: ${String(action)} (expected ${ACTIONS.join(' | ')})` };
          }
        } catch (e) {
          yield { type: 'error', message: `observer query failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  };
}
