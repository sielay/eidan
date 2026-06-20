# @eidandev/routines

eidan's **recurring routines** — a matbot plugin to schedule a prompt to run on
a cadence ("every morning at 08:00, brief me"). It registers the routine CRUD
tools the eidan brain drives conversationally, plus a background poll loop that
fires due routines as agent turns and delivers the result via @eidandev/notify.

The loop scans every owner's enabled routines each tick, evaluates each schedule
in the owner's timezone, and on a due window claims the fire through a cross-node
unique guard (`eidan.routine_runs`, unique on `(routine_id, fired_for)`), so in a
multi-node deploy exactly one node fires each window. It then runs the prompt as
a turn under the owner's identity (so the conversation + memory persist as that
user) and delivers the output to the owner's bound Telegram chat (if any) and on
the `routine` notify topic. (Generalised by @eidandev/agents, which adds
per-agent personas + providers and composable triggers.)

## Tools

| Tool | Purpose |
|------|---------|
| `routine_create` | Schedule a recurring prompt. Inputs: `name`, `schedule`, `prompt`. |
| `routine_list`   | List the operator's routines (name, schedule, prompt, enabled, last run). |
| `routine_update` | Rename / reschedule / edit the prompt / pause-resume (`enabled`); only passed fields change. |
| `routine_delete` | Delete a routine so it no longer runs. |

## Example

> **You:** Every morning at 8, summarise my calendar and unread email.
>
> → the agent calls `routine_create({ name: "Morning briefing", schedule: "08:00", prompt: "Summarise my calendar and unread email for today" })`
>
> *(next 08:00, owner timezone)* the loop runs the prompt as a turn and delivers the briefing on the `routine` topic.

Schedules are owner-local wall-clock: `"08:00"` (every day) or `"<days> HH:MM"`
(e.g. `"mon,wed,fri 08:00"`); a clock schedule fires once per day inside a grace
window that absorbs poll jitter / brief downtime.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds `Db`, registers the `Routines`
  service + tools, starts/stops the loop.
- `src/store.ts` — `RoutinesStore`: per-user CRUD (principal-scoped, every
  statement also `user_id`-scoped) + the cross-user `dueScan` / `claimRun` /
  `finishRun` the loop uses (no ambient principal).
- `src/schedule.ts` — pure schedule parsing + `dueWindow` (unit-tested).
- `src/runner.ts` — `runRoutineTurn`: runs the prompt as a turn under `runAs`.
- `src/loop.ts` — the detached poll loop (scan → claim → fire → deliver).
- `src/db.ts` — the principal-stamping transaction helper.

## Schema

`eidan.routines` + `eidan.routine_runs` (the per-fire dedup ledger). Applied by
the core migrate runner (`migrations/sql/*.sql`), not per-plugin.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**).
- `EIDAN_ROUTINE_PROVIDER` — provider for routine turns (falls back to
  `EIDAN_AGUI_PROVIDER`, then `EIDAN_JOB_PROVIDER`, then `claude`).
- `EIDAN_ROUTINE_POLL_MS` — scan interval (default `60000`).
- `EIDAN_ROUTINE_GRACE_MIN` — clock-window grace minutes (default `30`).
