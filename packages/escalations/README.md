# @eidandev/escalations

eidan's **human-in-the-loop inbox** — a matbot plugin over `eidan.escalations`.
When an agent or background loop is blocked, needs a decision or permission, hits
a budget/capacity limit, or cannot recover on its own, it raises an escalation:
the item lands in the operator's Inbox and the operator is pinged. The Inbox UI
lists / acknowledges / resolves these rows.

It exposes both an `Escalations` service (for plugins) and an `escalate` agent
tool (for turns) over **one** delivery path: `raise → (deduped) insert → ping`.
Escalations are deduped per agent — one pending escalation per `agentId` — so a
failing agent raises once per streak, not every tick (used by @eidandev/agents).
On a successful insert it pings the operator's bound Telegram chat (via
`TelegramChats`, the same vault-token path routines use) and emits the
`escalation` notify topic (Slack/other), both best-effort and dependency-free
(the services are narrowed, absent ⇒ no-op). Severity sets the prefix/level:
`high` → 🚨/error, else ⚠️/warn.

## Tools

| Tool | Purpose |
|------|---------|
| `escalate` | Flag something needing the operator. Inputs: `severity` (low/medium/high), `reason_class` (one of the reason enum), `suggested_action` (one clear line; required), optional `evidence[]` (urls/ids/quotes). Returns `{escalated:true,id}` or `{escalated:false,reason}` when deduped. |

The service surface (consumed by other plugins) is
`services.Escalations?.raise({ severity, reasonClass, suggestedAction, evidence,
agentId, conversationId, userId, metadata })` — `userId` lets background callers
with no ambient principal name the owner; `agentId` drives the per-agent dedup.

## Example

> An agent is blocked waiting on an API key it can't read.
>
> → it calls `escalate({ severity: "medium", reason_class: "missing_input", suggested_action: "Add the Stripe API key in Settings → Secrets, then re-run." })`
>
> → the row lands in the Inbox and the operator is pinged on Telegram + the `escalation` topic.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds `Db`, wraps the store insert
  with notify/Telegram delivery into the `Escalations` service, registers the
  service + the `escalate` tool.
- `src/store.ts` — `EscalationsStore.insert`: validates severity/reason_class
  (unknown coerce to `medium`/`other`), enforces per-agent dedup, inserts the
  row. Pure DB; delivery is the service wrapper's job.
- `src/tools.ts` — the `escalate` `Tool[]`.
- `src/db.ts` — the principal-stamping transaction helper (accepts an explicit
  `userId` for background callers, also `user_id`-scopes statements).

## Schema

`eidan.escalations` (`severity`, `reason_class`, `suggested_action`, `evidence`
jsonb, `metadata` jsonb incl. `agent_id`, `status` pending/…, `conversation_id`).
Applied by the core migrate runner (`migrations/sql/*.sql`), not per-plugin.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**).
- `EIDAN_NOTIFY_ROUTES` — route the `escalation` topic (in @eidandev/notify) so
  the ping is delivered to Slack/other.
