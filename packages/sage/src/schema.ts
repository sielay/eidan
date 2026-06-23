// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from './db.js';

// The Python bundle split its state across `plugin_git` (repos, repo_locks) and `plugin_sage`
// (pr_iterations, review_findings) because each Alembic-migrated plugin owned its own schema. The
// TS port collapses the four plugins into one package, so it owns ONE `sage` schema. The deploy
// path may later apply these via a shipped sql/ file + @eidandev/migrate; here we also ensure them
// idempotently at setup() so the bundle is self-contained and drops in without a separate migrate
// step (every statement is IF NOT EXISTS — safe to run on every boot).
const DDL = `
create schema if not exists sage;

-- One row per (host, owner, name) repo sage has touched. Lease + clone target.
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

-- Per-(repo, stack) workspace lease. The lease IS the authorisation surface: a node must hold it
-- before editing the shared clone. Single row per (repo, stack); a stale heartbeat is force-claimable.
create table if not exists sage.repo_locks (
  repo_id            uuid not null references sage.repos(id) on delete cascade,
  stack              text not null,
  node_id            text not null,
  lease_token        uuid not null,
  locked_at          timestamptz not null default now(),
  last_heartbeat_at  timestamptz not null default now(),
  primary key (repo_id, stack)
);

-- Durable per-PR loop cursor (005 §7). One row per sage-managed PR; the iteration poll advances it.
-- status: open | iterating | done | exhausted | escalated | failed (text, no enum — add freely).
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

-- Append-only audit log: one row per triaged iteration item (what Copilot/CI raised, how sage
-- classified it, which commit resolved it). Loop bookkeeping is pr_iterations; this is the story.
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
`;

export async function ensureSchema(db: Db): Promise<void> {
  await db.query(DDL);
}
