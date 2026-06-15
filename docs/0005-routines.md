<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0005 — Routines (recurring scheduled prompts)

Status: **Shipped** — `@eidandev/routines` (`packages/routines/`).

## Goal

Let the operator schedule a prompt to run on a cadence — "every morning at 08:00, brief me on my
calendar and unread mail", "Sundays at 20:00, ask me to review my goals". When a routine is due,
eidan runs the prompt as a normal agent turn (full tools + memory, as the owner) and delivers the
result to their notification channel. This is the scheduler eidan previously lacked, and the
foundation a proactive "amigdula" loop will build on.

## How it works

- **One table, one poll loop.** `eidan.routines` holds each routine; the plugin starts a detached
  loop (default every 60s) that scans enabled routines and fires any that are due.
- **Per-owner timezone.** A routine's `schedule` is wall-clock in the owner's timezone, read from
  `eidan.user_context` (`category='preferences'`, `key='timezone'`), defaulting to `UTC`.
- **Windowed firing.** A routine is due when local time is in `[scheduled, scheduled + grace)` on a
  matching weekday (grace default 30 min). This absorbs poll jitter and brief downtime, and means a
  routine created at 14:00 for "08:00" does **not** fire retroactively that day.
- **Runs as a turn.** Due routines run under `runAs(owner)` via `services.run.open` — the same path
  as chat — so the conversation and any memory writes persist as the owner, with their tools.
- **Delivery.** The result is emitted on the `@eidandev/notify` topic `routine` (route it to
  Telegram/Slack via `EIDAN_NOTIFY_ROUTES`). The text is also stored on the run row.
- **Exactly-once across nodes.** `eidan.routine_runs` has a unique `(routine_id, fired_for)` index.
  When several nodes share the database they all poll, but only one wins the insert for a given
  window — so a routine fires once per window no matter how many workers run.

## Schedule format

A small human string, owner-local:

| Example | Meaning |
|---|---|
| `08:00` | every day at 08:00 |
| `mon 08:00` | Mondays at 08:00 |
| `mon,wed,fri 18:30` | those weekdays at 18:30 |
| `sun 20:00` | Sundays at 20:00 |

Days are `mon tue wed thu fri sat sun`. Parsing/validation lives in `src/schedule.ts` (pure, unit-
testable); the tools reject a malformed schedule with a clear message.

## Tools (agent-facing)

- `routine_create` `{name, schedule, prompt}` — schedule a new recurring prompt.
- `routine_list` `{}` — list the operator's routines.
- `routine_update` `{id, name?, schedule?, prompt?, enabled?}` — edit, reschedule, or pause/resume.
- `routine_delete` `{id}` — remove a routine.

All are owner-scoped (the ambient `Principal`); routines never cross users.

## Config

| Env | Default | Meaning |
|---|---|---|
| `EIDAN_ROUTINE_PROVIDER` | falls back to `EIDAN_AGUI_PROVIDER` → `EIDAN_JOB_PROVIDER` → `claude` | LLM provider for routine turns. |
| `EIDAN_ROUTINE_POLL_MS` | `60000` | Poll interval. |
| `EIDAN_ROUTINE_GRACE_MIN` | `30` | Firing-window width after the scheduled time. |

Load order in `matbot.yaml`: after `notify` and `jobs`. Needs `EIDAN_DATABASE_URL`; apply the schema
with `pnpm --filter @eidandev/migrate migrate` (adds `0003_routines.sql`).

## Limitations / next

- Delivery uses the single `routine` notify topic — fine for single-operator self-hosting; per-user
  routing would need a Notify extension.
- A failed routine turn is not retried within the same window (the run is marked `failed`).
- The grace window does not span midnight; near-midnight schedules can miss if the node is down
  across 00:00.
- **Next:** this loop is the substrate for the proactive **amigdula** surface (background pattern
  detection + nudges) — that plugs in as routines that emit observations rather than user-authored
  prompts.

## Files of record

- `migrations/sql/0003_routines.sql` — `eidan.routines` + `eidan.routine_runs`.
- `packages/routines/src/schedule.ts` — pure schedule parse + due-window logic.
- `packages/routines/src/store.ts` — per-user CRUD + cross-user loop queries.
- `packages/routines/src/loop.ts` — the poll loop + fire/deliver.
- `packages/routines/src/runner.ts` — runs a routine prompt as a turn.
- `packages/routines/src/tools.ts`, `src/index.ts` — tools + plugin wiring.
