-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Sage bundle schema. The plugin also ensures this idempotently at setup() (src/schema.ts), so a
-- drop-in install needs no separate migrate step; this file is the deploy-time @eidandev/migrate
-- path for operators who prefer schema applied out-of-band. Every statement is IF NOT EXISTS, so
-- the two paths compose safely. Keep in sync with src/schema.ts.

create schema if not exists sage;

create table if not exists sage.repos (
  id              uuid primary key default gen_random_uuid(),
  host            text not null default 'github.com',
  owner           text not null,
  name            text not null,
  default_branch  text,
  last_synced_sha text,
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (host, owner, name)
);

create table if not exists sage.repo_locks (
  repo_id            uuid not null references sage.repos(id) on delete cascade,
  stack              text not null,
  node_id            text not null,
  lease_token        uuid not null,
  locked_at          timestamptz not null default now(),
  last_heartbeat_at  timestamptz not null default now(),
  primary key (repo_id, stack)
);

create table if not exists sage.pr_iterations (
  id              bigserial primary key,
  host            text not null default 'github.com',
  repo            text not null,
  pr_number       integer not null,
  head_ref        text not null,
  base_ref        text not null,
  stack           text,
  cwd             text not null,
  task_prompt     text,
  node_id         text not null,
  status          text not null default 'open',
  iteration       integer not null default 0,
  escalations     integer not null default 0,
  last_commit_sha text,
  last_input_sig  text,
  no_progress_passes integer not null default 0,
  last_unresolved integer,
  paused          boolean not null default false,
  user_id         uuid,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists uq_sage_pr_iter_pr
  on sage.pr_iterations (host, repo, pr_number);
create index if not exists idx_sage_pr_iter_live
  on sage.pr_iterations (node_id, status)
  where status in ('open', 'iterating');

create table if not exists sage.review_findings (
  id            bigserial primary key,
  host          text not null default 'github.com',
  repo          text not null,
  head_ref      text not null,
  base_ref      text not null,
  pr_number     integer,
  severity      text not null,
  kind          text,
  file          text,
  line          integer,
  message       text not null,
  suggested_fix text,
  outcome       text not null,
  commit_sha    text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_sage_findings_pr
  on sage.review_findings (host, repo, pr_number);
