# @eidandev/decisions

eidan's **decision log** — a searchable, first-class record of the choices
the agent and operator settle, kept deliberately *out* of the knowledge graph
so decisions stay their own retrievable surface (with `[[knowledge-slug]]`
links as connective tissue). The doctrine: **search before deciding, record
after.** It also ships durable per-job cursors so recurring jobs/agents resume
instead of repeating work.

Both surfaces live on the matbot `Store` (over `eidan.kv`), so they survive
restarts and are queryable by text, tag, and status via the reference query
engine. No service is registered — just the three agent-facing tools below.

## Tools

| Tool | Purpose |
|------|---------|
| `decision_record` | Record (or update) a decision: `title`, `decision`, optional `rationale`, `tags`, `links`, `status` (proposed/accepted/superseded/rejected, default accepted). Pass `id` to update; pass `supersedes` to replace a prior decision (auto-marked superseded). Returns the stored record. |
| `decision_search` | Search the log before re-deciding. Filter by `text` (substring over title/decision/rationale), `tags` (any-of), `status`; `limit` (default 20, max 100, newest first). |
| `job_cursor` | Durable per-job cursor. `action: get \| set \| list`; `job` keys the cursor; `set` persists arbitrary `state` plus an optional `note`. |

## Example

> **You:** We've decided to deploy from the canary repo, not core.
>
> → the agent calls `decision_record({ title: "Deploy from canary", decision: "Vercel deploys from eidan-canary", rationale: "core stays clean public AGPL", tags: ["deploy"] })`
>
> *(later, mid-task)* → before changing the deploy source the agent calls `decision_search({ text: "deploy" })` and finds the prior call instead of re-litigating it.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; creates the `decisions` and `job_cursor` stores via `services.createStore` and registers the three tools.
- `src/tools.ts` — `buildDecisionTools`: the `decision_record` / `decision_search` / `job_cursor` `Tool[]`, including supersede handling and the `Filter`/`StoreQuery` search.
- `src/types.ts` — `DecisionRecord` / `JobCursorRecord` row shapes and `DecisionStatus`.

## Schema

No SQL of its own. Both record kinds are matbot `Store` rows in the `decisions`
and `job_cursor` KV namespaces (backed by `eidan.kv`); `version` is minted by
the store layer on each write.

## Config

None. Scoping follows the ambient matbot `Principal` through the store layer;
there is no plugin-specific env var.
