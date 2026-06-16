<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0016 — LLM call ledger

Status: **Shipped** — `@eidandev/llm-calls` over `eidan.llm_calls`.

## Goal

A per-call cost/usage ledger: one immutable row per provider call recording tokens (input, output,
cache read/creation) and cost, scoped to the user and (when known) the conversation. It is the data
behind any spend dashboard, per-user budgeting, or model-mix analysis — captured at the point of
truth (the usage event a frontend already receives) rather than reconstructed from logs.

## How it works

- **Service, not a hook.** The plugin registers `services.LlmCalls` (an `MatbotServices` augment).
  Whoever owns a provider call — today the chat frontends — calls `services.LlmCalls?.record(call)`
  on each usage event. The `?.` matters: if the ledger plugin isn't loaded (or has no DB), callers
  degrade silently.
- **One row per call.** `record()` INSERTs into `eidan.llm_calls`
  (`user_id`, `conversation_id`, `role`, `provider`, `model`, `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `request_id`, `started_at`). `role`
  defaults to `'primary'`; the token/cost fields default to `0` and ids to `null`.
- **Telemetry never breaks a turn.** `record()` wraps the INSERT in try/catch and only `console.warn`s
  on failure — a ledger write must never throw into the request path.
- **Immutable.** `eidan.llm_calls` is append-only (no soft-delete, no update); rows are facts about a
  call that happened.

## Config

| Env | Meaning |
|---|---|
| `EIDAN_DATABASE_URL` (or `DATABASE_URL`) | Postgres connection string. If unset, the plugin logs `ledger disabled` and registers nothing — callers' `services.LlmCalls?.record()` becomes a no-op. |

## Files of record

- `packages/llm-calls/src/llm-calls.ts` — `LlmCall` / `LlmCalls` interfaces + `LlmCallsImpl.record()`.
- `packages/llm-calls/src/index.ts` — boot: registers `LlmCalls`, augments `MatbotServices`.
- `migrations/sql/` — the `eidan.llm_calls` table.
- Related: [[0012-frontend-agui]] (a caller of `record()`); [[0013-architecture]].
