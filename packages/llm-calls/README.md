# @eidandev/llm-calls

eidan's **per-call cost/token ledger** — it records one immutable row per
provider call (tokens in/out, cache tokens, USD cost) to `eidan.llm_calls`, so
usage and spend are queryable per user, conversation, and model. This is the
data behind cost dashboards and budget enforcement; the plugin itself only
writes the ledger.

This plugin registers the **`LlmCalls` service**, not agent tools — so it has no
Tools table. Frontends (e.g. `frontend-agui`) call `services.LlmCalls?.record()`
on each provider usage event; telemetry must never break a turn, so a failed
write is logged and swallowed, never thrown.

## What it provides

- **`LlmCalls` service** (`LlmCallsImpl`) with a single method:
  `record(call: LlmCall): Promise<void>` → INSERTs into `eidan.llm_calls`.
  `LlmCall` carries `userId`, optional `conversationId`/`messageId`/`role`
  (default `'primary'`), `provider`, `model`, `inputTokens`, `outputTokens`,
  and optional `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `requestId`.

## How others consume it

```ts
await services.LlmCalls?.record({
  userId, conversationId, provider: 'anthropic', model,
  inputTokens, outputTokens, costUsd,
});
```

The frontend that owns the provider turn (it knows the usage numbers and the
acting user) is the caller; the optional chaining means the ledger degrades
gracefully when the plugin isn't loaded.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds `Db` from
  `EIDAN_DATABASE_URL` and registers `LlmCalls` (warns + disables if unset).
- `src/llm-calls.ts` — the `LlmCall` shape, the `LlmCalls` interface, and
  `LlmCallsImpl` (the never-throw INSERT).
- `src/db.ts` — a thin pg pool wrapper. No principal GUC: the ledger sets
  `user_id` explicitly and `eidan.llm_calls` has no RLS in core.

## Schema

`eidan.llm_calls` — one immutable row per call (`user_id`, `conversation_id`,
`message_id`, `role`, `provider`, `model`, `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `request_id`,
`started_at`). Applied by the core migrate runner (`migrations/sql/*.sql`), not
per-plugin.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection. If unset the
  plugin logs a warning and the ledger is disabled (it does not throw).
