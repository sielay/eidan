# @eidandev/llm-spend-analytics

Spend analytics tools for cloud LLM providers — **trailing-30-day spend breakdown** from OpenRouter, Anthropic, and OpenAI APIs for hardware buy-decision evaluation (Model & Cache Observer agent gates).

Each tool queries the provider's API for historical usage and cost data, returning:

- **Total spend** (USD or account currency)
- **Spend by model** (with input/output token costs separated)
- **Cache hit rate** (where provider exposes it)
- **7-day and 30-day trends** (daily spend buckets for spike alerting)

## Tools

**`openrouter_spend_analytics()`** — OpenRouter trailing-30-day spend. Requires `OPENROUTER_API_KEY`.

**`anthropic_spend_analytics()`** — Anthropic trailing-30-day spend. Requires `ANTHROPIC_API_KEY`.

**`openai_spend_analytics()`** — OpenAI trailing-30-day spend. Requires `OPENAI_API_KEY`.

All three are callable from any agent and cached for 6 hours to avoid redundant API calls.

## Implementation notes

**API Limitations by provider:**
- **OpenRouter:** Spend data via `/api/v1/usage/calls` — returns model breakdowns, cache hit rates, and total cost per call. Input/output token costs estimated based on prompt/completion token ratio from usage data.
- **Anthropic:** No public billing/usage history API. The `/v1/messages` endpoint exposes per-call usage metadata but not historical aggregates. Tool returns an error; users must check billing via `console.anthropic.com/account/billing/overview`.
- **OpenAI:** Spend data via `/v1/dashboard/billing/usage` with daily model-level breakdowns, but no per-token-type cost separation. Tool returns an error due to inability to provide required input/output token cost breakdown. Users must check billing via `platform.openai.com/account/billing/overview`.

**Retry + rate-limit handling:** Built-in exponential backoff for transient failures. Respects `Retry-After` headers on 429s.

**Caching:** Responses cached in-memory for 6 hours (`CACHE_TTL_MS`). Cache is ephemeral (per-process), so distributed nodes recompute independently.

**Error handling:** Missing or invalid API keys return structured errors. API failures log and return an error message (non-blocking).

## Config

- `OPENROUTER_API_KEY` (optional) — Get from https://openrouter.ai/keys
- `ANTHROPIC_API_KEY` (optional) — Get from https://console.anthropic.com/account/keys
- `OPENAI_API_KEY` (optional) — Get from https://platform.openai.com/account/api-keys (must be org/project-level with billing read access)

All three are stored in the matbot vault (encrypted at rest). The agent requests them via the `secret` tool when needed.

## Gateway use (Model & Cache Observer)

The Model & Cache Observer agent uses these tools to populate SCAN 6 (hardware buy-decision gate):

```
"can a local model serve this workload cost-effectively?"
→ requires knowing: current cloud spend per provider/model
→ calls: openai_spend_analytics(), anthropic_spend_analytics(), openrouter_spend_analytics()
→ compares: local inference cost vs cloud baseline
```

## Schema

No persistent schema. Responses are structured (`SpendAnalytics` interface in `src/types.ts`) and cached in-memory.

## Future work

- OpenAI: await API that exposes input/output token cost separation, or use `POST /v1/chat/completions` with `logprobs` to track usage per-call
- Anthropic: await public billing/usage API (currently console-only)
- Cache-hit-rate aggregation: currently available for OpenRouter; expand to other providers as they expose cache metrics
