-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Graceful-shutdown continuation. When a node restarts (e.g. a deploy) while a standing agent has an
-- in-flight turn, the turn is aborted and a row is queued here; the node re-fires it (a continuation
-- turn that references the interrupted conversation) on next boot. Lets a deploy interrupt agents
-- without losing their work or waiting for the next schedule window.

create table if not exists eidan.agent_restart_queue (
  id              uuid        primary key default gen_random_uuid(),
  agent_id        uuid        not null,
  trigger_id      uuid,
  user_id         uuid        not null,
  conversation_id uuid,                         -- the interrupted turn's conversation (continuation ref)
  fire_key        text,                         -- the schedule fire that was interrupted
  node_id         text,                         -- the node that was interrupted (resumes there)
  reason          text,
  state           jsonb       not null default '{}'::jsonb,  -- persona/provider/model snapshot to re-fire
  status          text        not null default 'pending',     -- pending | resumed | abandoned
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resumed_at      timestamptz,
  deleted_at      timestamptz,
  constraint agent_restart_queue_status_chk
    check (status = any (array['pending'::text, 'resumed'::text, 'abandoned'::text]))
);

create index if not exists idx_agent_restart_queue_pending
  on eidan.agent_restart_queue (created_at)
  where status = 'pending' and deleted_at is null;

-- Let a scheduled run record an 'interrupted' outcome (node restart) distinct from 'failed', so the
-- failure-streak escalation never trips on a deploy. PG has no ADD CONSTRAINT IF NOT EXISTS → drop+add.
alter table eidan.agent_runs drop constraint if exists agent_runs_status_chk;
alter table eidan.agent_runs
  add constraint agent_runs_status_chk
  check (status = any (array['started'::text, 'delivered'::text, 'failed'::text, 'interrupted'::text]));
