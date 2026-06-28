# @eidandev/agents

eidan's **user-defined agents** — a matbot plugin for an unlimited registry of
agents, each a persona with its own model provider, bound to composable
**triggers**. It registers the agent + trigger CRUD tools the eidan brain drives
conversationally, and a cluster-deduped dispatch loop that fires due triggers.
This generalises @eidandev/routines (epic sielay/eidan#346); the **schedule**
trigger is slice 1 (sensor + webhook triggers will add their own dispatch paths).

The loop scans every owner's enabled schedule triggers each tick, evaluates each
schedule in the owner's timezone, and on a due window claims the fire through a
cross-node unique guard (`eidan.agent_runs`, unique on `(trigger_id, fire_key)`),
so exactly one node fires each window. It runs the agent's persona as a turn
under the owner's identity, using the agent's **own** provider — a per-turn
synthetic provider profile is registered when a `model` override is set, so an
agent can run any model (e.g. any OpenRouter slug) without a restart. **Model
selection is hierarchical**: trigger override > agent override > node default.
This lets a single agent use different models per trigger (e.g. Haiku for a
weekly synthesis but DeepSeek for daily coordination). The produced conversation
is tagged `origin=agent` (kept out of the human chat sidebar) and the output is
delivered on the `agent` notify topic. An agent pinned to a `target_node` is only
fired by that node (e.g. a local-ollama agent on the Pi). A per-fire hard timeout
aborts stuck turns; after a streak of consecutive failures the loop raises an
escalation via @eidandev/escalations (best-effort, deduped per agent).

## Tools

| Tool | Purpose |
|------|---------|
| `agent_create` | Create an agent (persona + optional `provider` / `model` / `target_node`). Does nothing until a trigger is attached. |
| `agent_list`   | List the operator's agents, each with its triggers. |
| `agent_update` | Rename / edit persona / switch provider-model / pin node / pause-resume (`enabled`); only passed fields change. |
| `agent_delete` | Delete an agent (and its triggers). |
| `agent_schedule` | Attach a recurring **schedule** trigger to an agent. Optional `model` overrides the agent's model for this trigger. |
| `agent_relate` | Declare agent relationships (delegates_to / reviews / reports_to / escalates_to / decision_gate). Optional `model` (decision_gate only) overrides the agent's model. |
| `agent_trigger_delete` | Remove a trigger (the agent stays). |

## Example

> **You:** Make an agent that reviews my Vercel mail every weekday at 9 and flags errors.
>
> → `agent_create({ name: "Vercel log analyst", persona: "Review my unread mail from Vercel and summarise any errors or anomalies" })`
> then `agent_schedule({ agent_id, schedule: "mon,tue,wed,thu,fri 09:00" })`
>
> *(each weekday 09:00, owner timezone)* the loop runs the persona under the agent's provider and delivers on the `agent` topic.

Schedules accept clock (`"08:00"`, `"mon,wed,fri 18:30"`) and interval (`"every 5
minutes"`, `"every 2 hours"`, `"hourly"`) forms.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds `Db`, registers the `Agents`
  service + tools, starts/stops the dispatch loop.
- `src/store.ts` — `AgentsStore`: per-user agent + trigger CRUD (principal- and
  `user_id`-scoped) plus the cross-user loop queries (`dueScheduleScan`,
  `claimRun`, `recentFailureStreak`, `markAgentConversation`, `finishRun`).
- `src/schedule.ts` — pure clock/interval parsing + `dueWindow`.
- `src/runner.ts` — `runAgentTurn`: runs the persona as a turn under `runAs`,
  returns the final text + conversation id.
- `src/loop.ts` — the detached dispatch loop (per-turn provider synthesis,
  per-fire timeout, failure-streak escalation; narrows `Notify` / `Escalations`).
- `src/db.ts` — the principal-stamping transaction helper.

## Schema

`eidan.agents`, `eidan.agent_triggers`, `eidan.agent_runs` (the per-fire dedup
ledger). Reads `eidan.user_context` (timezone) and stamps `eidan.conversations`
metadata. Applied by the core migrate runner (`migrations/sql/*.sql`).

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**).
- `EIDAN_AGENT_PROVIDER` — default provider (falls back to `EIDAN_AGUI_PROVIDER`,
  then `EIDAN_JOB_PROVIDER`, then `claude`).
- `EIDAN_NODE_ID` — this node's id, matched against an agent's `target_node`.
- `EIDAN_AGENT_POLL_MS` — scan interval (default `60000`).
- `EIDAN_AGENT_GRACE_MIN` — clock-window grace minutes (default `30`).
- `EIDAN_AGENT_TURN_TIMEOUT_MS` — per-fire hard cap (default `240000`).
