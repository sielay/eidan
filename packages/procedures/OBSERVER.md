# Model & Cache Observer Procedures

Four non-LLM data aggregation procedures for monitoring LLM usage, agent efficiency, and cost trends over the last 24 hours.

## Overview

These procedures enable real-time observability:

- **Token Summary (24h)** — aggregate token usage by provider/model, breakdown of input/output/cache tokens
- **Agent Activity (24h)** — track which agents ran, with which models, total tokens consumed per agent, last run time
- **Cost Estimate Breakdown** — apply pricing formulas (Haiku, Sonnet, Deepseek) to token counts, project monthly cost
- **Efficiency Flags (24h)** — detect optimization opportunities: expensive models on routine tasks, logging gaps, low cache hit rates

## Key Features

- **No LLM inference** — pure data transformation and SQL aggregation
- **Self-contained** — each procedure queries the database directly; no dependencies between procedures
- **Fast execution** — combined execution time <500ms; suitable for polling or scheduled dashboards
- **Structured output** — JSON results parse directly into dashboards or further analysis without agent re-processing
- **Operator-configurable pricing** — modify rate constants inline for different model cost schedules

## Setup

### Prerequisites

These procedures require database query access:

1. **Environment variable** — add to `matbot.yaml`:
   ```yaml
   EIDAN_PROCEDURE_TOOLS: db_query,remember,recall
   ```
   (Adds `db_query` tool to the procedure allowlist. Adjust comma-separated list to include other tools as needed.)

2. **Database connection** — the `db_query` tool requires an active Postgres connection. By default, it uses the main eidan database.

### Promoting the Procedures

**Option A: Via Chat (Recommended)**

Ask an agent to promote all four:

> **You:** Promote the token_summary_24h, agent_activity_24h, cost_estimate_breakdown, and efficiency_flags_24h procedures for real-time LLM observability.

The agent will present each procedure, ask for confirmation, and save them to `eidan.procedures`.

**Option B: Direct SQL**

Insert procedures directly:

```sql
INSERT INTO eidan.procedures (user_id, name, source) VALUES
  ('your-user-id', 'token_summary_24h', '... JavaScript source ...'),
  ('your-user-id', 'agent_activity_24h', '... JavaScript source ...'),
  ('your-user-id', 'cost_estimate_breakdown', '... JavaScript source ...'),
  ('your-user-id', 'efficiency_flags_24h', '... JavaScript source ...');
```

Procedure sources are exported from `@eidandev/procedures` in `observer-procedures.ts`.

## Usage

### 1. Token Summary (24h)

Query token breakdown by provider/model for the last 24 hours.

```javascript
await callTool('procedures', {
  action: 'run_saved',
  name: 'token_summary_24h'
});
```

**Returns:**
```json
{
  "timestamp": "2026-06-29T14:30:00Z",
  "total_calls": 1240,
  "total_tokens": 15340000,
  "breakdown": [
    {
      "provider": "anthropic",
      "model": "claude-3-5-sonnet",
      "call_count": 850,
      "total_input": 8500000,
      "total_output": 6200000,
      "total_tokens": 14700000,
      "avg_per_call": 17294.12
    },
    {
      "provider": "openrouter",
      "model": "deepseek",
      "call_count": 390,
      "total_input": 480000,
      "total_output": 160000,
      "total_tokens": 640000,
      "avg_per_call": 1641.03
    }
  ]
}
```

**Use cases:**
- Understand token distribution across models and providers
- Identify which models are consuming the most tokens
- Track input vs. output token balance for cache planning

### 2. Agent Activity (24h)

Track which agents executed and their token usage.

```javascript
await callTool('procedures', {
  action: 'run_saved',
  name: 'agent_activity_24h'
});
```

**Returns:**
```json
{
  "timestamp": "2026-06-29T14:30:00Z",
  "total_runs": 42,
  "agents_active": [
    {
      "agent_name": "Daily Digest Composer",
      "model": "claude-3-5-sonnet",
      "run_count": 12,
      "total_tokens": 8400000,
      "last_run": "2026-06-29T14:25:00Z"
    },
    {
      "agent_name": "Email Classifier",
      "model": "claude-3-5-haiku",
      "run_count": 30,
      "total_tokens": 2800000,
      "last_run": "2026-06-29T14:28:00Z"
    }
  ]
}
```

**Use cases:**
- Monitor which scheduled agents are active
- Identify heavy token consumers by agent
- Track agent execution frequency and timing

### 3. Cost Estimate Breakdown

Apply pricing formulas to estimate cost and monthly projection.

```javascript
await callTool('procedures', {
  action: 'run_saved',
  name: 'cost_estimate_breakdown'
});
```

**Returns:**
```json
{
  "timestamp": "2026-06-29T14:30:00Z",
  "providers": [
    {
      "provider": "anthropic",
      "model": "claude-3-5-sonnet",
      "tokens": 14700000,
      "rate_per_1m": "$3.00/$15.00",
      "estimated_cost_usd": 95.10
    },
    {
      "provider": "openrouter",
      "model": "deepseek",
      "tokens": 640000,
      "rate_per_1m": "$0.14/$0.28",
      "estimated_cost_usd": 0.12
    }
  ],
  "total_cost_24h_usd": 95.22,
  "monthly_projection_usd": 2856.60
}
```

**Pricing reference** (inline configurable):
- Haiku: $0.80 input / $2.40 output per 1M tokens
- Sonnet: $3.00 input / $15.00 output per 1M tokens
- Deepseek: $0.14 input / $0.28 output per 1M tokens
- Other models: defaults to mid-tier ($0.50/$1.50 per 1M)

**Use cases:**
- Budget forecasting and cost tracking
- Compare cost-efficiency between models
- Project monthly spend based on 24h baseline

### 4. Efficiency Flags (24h)

Detect optimization opportunities and anomalies.

```javascript
await callTool('procedures', {
  action: 'run_saved',
  name: 'efficiency_flags_24h'
});
```

**Returns:**
```json
{
  "timestamp": "2026-06-29T14:30:00Z",
  "high_cost_agents": [
    {
      "name": "Legacy Report Generator",
      "model": "claude-3-5-opus",
      "tokens": 1200000,
      "reason": "expensive model on routine task (consider downgrading to Haiku)"
    }
  ],
  "logging_gaps": [
    {
      "agent": "Tool-Only Agent",
      "run_count": 15,
      "reason": "runs recorded but no LLM calls logged — check if tool calls are replacing inference"
    }
  ],
  "cache_misses": [
    {
      "provider": "anthropic",
      "model": "claude-3-5-sonnet",
      "tokens": 8400000,
      "input_output_ratio": 1.37,
      "reason": "high input-to-output ratio with low cache hit rate — enable prompt caching"
    }
  ]
}
```

**Flags explained:**
- **high_cost_agents** — agents using expensive models for lightweight work; candidate for downgrade to Haiku
- **logging_gaps** — agents with recorded runs but no LLM calls; may indicate tool-only execution or logging configuration issue
- **cache_misses** — models with high input-to-output ratios and low cache hit rates; opportunity to enable prompt caching to reduce costs

**Use cases:**
- Identify quick wins for cost optimization
- Spot configuration issues (logging gaps, model mismatches)
- Guide cache strategy decisions

## Customization

### Adjusting Pricing

Edit the pricing map in `cost_estimate_breakdown` procedure source to match your contract rates:

```javascript
const pricing = {
  'claude-3-5-haiku': { input: 80, output: 240 },      // per 1M in USD cents
  'claude-3-5-sonnet': { input: 3000, output: 15000 }, // adjust these
  'deepseek': { input: 14, output: 28 },
  // Add custom rates for other models
};
```

### Performance Tuning

All four procedures execute SQL queries with aggregation. Query performance depends on:
- Volume of `eidan.llm_calls` rows (typically <100k per user per month)
- Indexes on `created_at` and `provider`/`model` (automatically created in schema)

For high-volume deployments (>1M calls/month), consider materializing 24h aggregates in a view.

## Troubleshooting

**"tool not exposed to procedures"**
- Check `EIDAN_PROCEDURE_TOOLS` includes `db_query`
- Verify environment variable is set in `matbot.yaml` before starting the node

**"unknown tool: db_query"**
- Confirm the `db` plugin is enabled in `matbot.yaml`
- Verify database connection is configured

**Empty results**
- Check that LLM calls or agent runs actually occurred in the last 24 hours
- Query `eidan.llm_calls` and `eidan.agent_runs` directly to verify data exists
