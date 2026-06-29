// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Data aggregation procedures for Model & Cache Observer agent.
 * All 4 procedures are pure data transformations with NO LLM inference required.
 * They query eidan.llm_calls and eidan.agent_runs, aggregate by provider/model, and flag efficiency issues.
 *
 * Requires EIDAN_PROCEDURE_TOOLS to include: db_query
 */

export const tokenSummary24h = `
// Query token breakdown by provider/model for last 24 hours.
// Returns structured JSON with total calls, tokens, and per-model breakdown.
// Execution: single optimized SQL query with aggregation.

const result = await callTool('db_query', {
  sql: \`
    SELECT
      provider,
      model,
      COUNT(*) as call_count,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      SUM(input_tokens + output_tokens) as total_tokens,
      ROUND(AVG(input_tokens + output_tokens)::numeric, 2) as avg_tokens_per_call
    FROM eidan.llm_calls
    WHERE created_at > now() - interval '24 hours'
      AND deleted_at IS NULL
    GROUP BY provider, model
    ORDER BY total_tokens DESC
  \`
});

if (result.error) {
  throw new Error(\`Database query failed: \${result.error}\`);
}

// Build summary
let totalCalls = 0;
let totalTokens = 0;
const breakdown = [];

for (const row of result.rows || []) {
  const callCount = parseInt(row.call_count || '0');
  const totalTok = parseInt(row.total_tokens || '0');
  totalCalls += callCount;
  totalTokens += totalTok;

  breakdown.push({
    provider: row.provider,
    model: row.model,
    call_count: callCount,
    total_input: parseInt(row.total_input || '0'),
    total_output: parseInt(row.total_output || '0'),
    total_tokens: totalTok,
    avg_per_call: parseFloat(row.avg_tokens_per_call || '0'),
  });
}

return {
  timestamp: new Date().toISOString(),
  total_calls: totalCalls,
  total_tokens: totalTokens,
  breakdown,
};
`;

export const agentActivity24h = `
// Query agent runs and token usage for last 24 hours.
// Joins agent_runs + agents + llm_calls to show which agents ran, with which models, and total tokens.
// Returns agents_active list sorted by token usage.

const result = await callTool('db_query', {
  sql: \`
    SELECT
      a.name as agent_name,
      a.model,
      COUNT(DISTINCT ar.id) as run_count,
      SUM(lc.input_tokens + lc.output_tokens) as total_tokens,
      MAX(ar.created_at) as last_run
    FROM eidan.agent_runs ar
    JOIN eidan.agents a ON ar.agent_id = a.id
    LEFT JOIN eidan.llm_calls lc ON ar.conversation_id = lc.conversation_id
    WHERE ar.created_at > now() - interval '24 hours'
      AND a.deleted_at IS NULL
    GROUP BY a.id, a.name, a.model
    ORDER BY total_tokens DESC
  \`
});

if (result.error) {
  throw new Error(\`Database query failed: \${result.error}\`);
}

const agentsActive = [];
let totalRuns = 0;

for (const row of result.rows || []) {
  const runCount = parseInt(row.run_count || '0');
  totalRuns += runCount;

  agentsActive.push({
    agent_name: row.agent_name,
    model: row.model || 'unknown',
    run_count: runCount,
    total_tokens: parseInt(row.total_tokens || '0'),
    last_run: row.last_run,
  });
}

return {
  timestamp: new Date().toISOString(),
  total_runs: totalRuns,
  agents_active: agentsActive,
};
`;

export const costEstimateBreakdown = `
// Apply pricing formulas to token counts from the last 24 hours.
// Uses pricing: Haiku $0.80/$2.40, Sonnet $3/$15, Deepseek $0.14/$0.28 per 1M tokens.
// Returns cost breakdown and monthly projection. Self-contained: queries DB directly.

// Pricing map: provider/model -> {input, output} rates (in USD cents per 1M tokens)
const pricing = {
  'anthropic/claude-3-5-haiku': { input: 80, output: 240 },
  'claude-3-5-haiku': { input: 80, output: 240 },
  'haiku': { input: 80, output: 240 },
  'anthropic/claude-3-5-sonnet': { input: 3000, output: 15000 },
  'claude-3-5-sonnet': { input: 3000, output: 15000 },
  'sonnet': { input: 3000, output: 15000 },
  'openrouter/deepseek': { input: 14, output: 28 },
  'deepseek': { input: 14, output: 28 },
};

const result = await callTool('db_query', {
  sql: \`
    SELECT
      provider,
      model,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      SUM(input_tokens + output_tokens) as total_tokens
    FROM eidan.llm_calls
    WHERE created_at > now() - interval '24 hours'
      AND deleted_at IS NULL
    GROUP BY provider, model
    ORDER BY total_tokens DESC
  \`
});

if (result.error) {
  throw new Error(\`Database query failed: \${result.error}\`);
}

let totalCost = 0;
const providers = [];

for (const row of result.rows || []) {
  const key = \`\${row.provider}/\${row.model}\`;
  const model_key = (row.model || '').toLowerCase();

  let rates = pricing[key] || pricing[model_key];
  if (!rates) {
    rates = { input: 500, output: 1500 }; // fallback: mid-tier pricing
  }

  const inputTok = parseInt(row.total_input || '0');
  const outputTok = parseInt(row.total_output || '0');
  const inputCost = (inputTok / 1000000) * rates.input;
  const outputCost = (outputTok / 1000000) * rates.output;
  const modelCost = inputCost + outputCost;
  totalCost += modelCost;

  providers.push({
    provider: row.provider,
    model: row.model,
    tokens: parseInt(row.total_tokens || '0'),
    rate_per_1m: \`\$\${(rates.input / 100).toFixed(2)}/\$\${(rates.output / 100).toFixed(2)}\`,
    estimated_cost_usd: Math.round(modelCost * 100) / 100,
  });
}

const totalCost24hUsd = Math.round(totalCost * 100) / 100;
const monthlyProjection = Math.round(totalCost24hUsd * 30 * 100) / 100;

return {
  timestamp: new Date().toISOString(),
  providers,
  total_cost_24h_usd: totalCost24hUsd,
  monthly_projection_usd: monthlyProjection,
};
`;

export const efficiencyFlags24h = `
// Detect efficiency issues from agent runs and token usage over last 24 hours.
// Self-contained: queries both agent_runs and llm_calls, applies comparison logic.
// Returns structured list of flags: high-cost agents, logging gaps, potential cache misses.

// Fetch agent activity data
const agentResult = await callTool('db_query', {
  sql: \`
    SELECT
      a.name as agent_name,
      a.model,
      COUNT(DISTINCT ar.id) as run_count,
      COALESCE(SUM(lc.input_tokens + lc.output_tokens), 0) as total_tokens
    FROM eidan.agent_runs ar
    JOIN eidan.agents a ON ar.agent_id = a.id
    LEFT JOIN eidan.llm_calls lc ON ar.conversation_id = lc.conversation_id
    WHERE ar.created_at > now() - interval '24 hours'
      AND a.deleted_at IS NULL
    GROUP BY a.id, a.name, a.model
  \`
});

// Fetch token summary data
const tokenResult = await callTool('db_query', {
  sql: \`
    SELECT
      provider,
      model,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      SUM(input_tokens + output_tokens) as total_tokens,
      SUM(cache_read_tokens) as cache_read_tokens
    FROM eidan.llm_calls
    WHERE created_at > now() - interval '24 hours'
      AND deleted_at IS NULL
    GROUP BY provider, model
  \`
});

if (agentResult.error || tokenResult.error) {
  throw new Error(\`Database query failed: agent=\${agentResult.error} token=\${tokenResult.error}\`);
}

const flags = {
  high_cost_agents: [],
  logging_gaps: [],
  cache_misses: [],
};

// Model cost rankings (relative weight)
const modelCost = {
  'sonnet': 5,
  'opus': 6,
  'haiku': 1,
  'deepseek': 0.5,
};

// Calculate average tokens for context
let avgTokens = 0;
let tokenCount = 0;
for (const row of tokenResult.rows || []) {
  const toks = parseInt(row.total_tokens || '0');
  avgTokens += toks;
  tokenCount++;
}
if (tokenCount > 0) {
  avgTokens = avgTokens / tokenCount;
}

// Flag 1: High-cost agents (expensive model on routine task)
for (const row of agentResult.rows || []) {
  const modelName = (row.model || '').toLowerCase();
  const agentTokens = parseInt(row.total_tokens || '0');

  // Find cost tier from model name
  let cost = 2; // default: mid-tier
  for (const [key, val] of Object.entries(modelCost)) {
    if (modelName.includes(key)) {
      cost = val;
      break;
    }
  }

  // Flag expensive models doing lightweight work
  if (cost >= 4 && agentTokens > 0 && agentTokens < avgTokens * 0.5) {
    flags.high_cost_agents.push({
      name: row.agent_name,
      model: row.model,
      tokens: agentTokens,
      reason: 'expensive model on routine task (consider downgrading to Haiku)',
    });
  }
}

// Flag 2: Logging gaps (agent runs but no llm_calls logged)
for (const row of agentResult.rows || []) {
  const runCount = parseInt(row.run_count || '0');
  const totalTokens = parseInt(row.total_tokens || '0');
  if (runCount > 0 && totalTokens === 0) {
    flags.logging_gaps.push({
      agent: row.agent_name,
      run_count: runCount,
      reason: 'runs recorded but no LLM calls logged — check if tool calls are replacing inference',
    });
  }
}

// Flag 3: Potential cache misses (high input, low cache hit rate)
for (const row of tokenResult.rows || []) {
  const inputTok = parseInt(row.total_input || '0');
  const outputTok = parseInt(row.total_output || '0');
  const cacheTok = parseInt(row.cache_read_tokens || '0');
  const totalTok = parseInt(row.total_tokens || '0');

  if (outputTok > 0) {
    const cacheHitRate = totalTok > 0 ? cacheTok / totalTok : 0;

    // Heuristic: high input-to-output ratio with low cache hit rate
    if (inputTok > outputTok * 1.5 && cacheHitRate < 0.1) {
      flags.cache_misses.push({
        provider: row.provider,
        model: row.model,
        tokens: totalTok,
        input_output_ratio: Math.round((inputTok / outputTok) * 100) / 100,
        reason: 'high input-to-output ratio with low cache hit rate — enable prompt caching',
      });
    }
  }
}

return {
  timestamp: new Date().toISOString(),
  high_cost_agents: flags.high_cost_agents.slice(0, 10),
  logging_gaps: flags.logging_gaps.slice(0, 10),
  cache_misses: flags.cache_misses.slice(0, 10),
};
`;
