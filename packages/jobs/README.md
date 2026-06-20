# @eidandev/jobs

eidan's **delegation work-queue** — a matbot plugin that turns rows in
`eidan.jobs` into work. On setup it starts a detached worker that claims queued
jobs by capability **kind** (`FOR UPDATE SKIP LOCKED`, so any number of nodes
can run side-by-side without double-claiming) and runs each to completion,
writing the outcome back onto the job row (`status`, `result`, `error`).

It registers no agent tools. Instead it exposes the **`JobHandlers`** service
(the kind→handler registry) so bundles can plug in kind-specific workers:
`services.JobHandlers?.register('code', sageCodeHandler)`. Sage registers a
`code` handler; the queue itself is generic. The built-in `chat` handler is the
default for any unhandled kind — it runs the job's `goal` as a single agent turn
under the delegating user's identity (`runAs(job.user_id)`), so the session and
its messages persist as that user, and captures the final assistant text.

## What it provides

- **`JobHandlers` service** — `register(kind, handler)` / `get(kind)`. A handler
  is `(job, services) => Promise<{ result? }>`; throwing marks the job `failed`.
- **The worker loop** — claim → `running` → run handler → `done`(+result) or
  `failed`(+error). Poll-driven (default 2s); `stop()` ends it after the
  in-flight job. Claim errors back off 5s and retry; the loop never dies.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; reads config, builds `Db`, registers
  the `chat` handler + the `JobHandlers` service, starts/stops the worker.
- `src/job-runner.ts` — `JobHandlerRegistry`, the default `makeTurnHandler`
  (turn-as-job), the `claimOne` / `mark*` SQL, and `startJobWorker`.
- `src/session-text.ts` — `lastAssistantText`, pure (unit-tested) session helper.
- `src/db.ts` — pool + `tx` helper for the claim. The queue is node-scoped, not
  user-scoped, so `eidan.jobs` has no RLS and `Db` sets no ambient principal.

## Schema

`eidan.jobs` (`kind`, `goal`, `payload`, `surface`, `user_id`, `status`,
`claimed_by`/`claimed_at`, `result`, `error`). Applied by the core migrate
runner (`migrations/sql/*.sql`), not per-plugin.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**).
- `EIDAN_JOB_KINDS` — comma list of kinds this node claims (default `chat`).
- `EIDAN_JOB_PROVIDER` — provider for the default turn handler (default `claude`).
- `EIDAN_NODE_ID` — claimer id stamped on `claimed_by` (default `mb-<random>`).
