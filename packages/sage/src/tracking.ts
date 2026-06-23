// SPDX-License-Identifier: AGPL-3.0-or-later
// pr_iterations cursor: durable per-PR loop state (005 §7). The pipeline seeds one row when it
// opens a PR (it has cwd / head / base / number in hand); the iteration poll then advances it.
// This is the loop bookkeeping; review_findings (a later brick) is the append-only audit story.
import type { Db } from './db.js';

export interface SeedCursorOpts {
  host: string;
  repo: string; // owner/repo
  prNumber: number;
  headRef: string;
  baseRef: string;
  stack: string | null;
  cwd: string;
  taskPrompt: string | null;
  nodeId: string;
  lastCommitSha: string | null;
  userId: string | null;
}

// Upsert the cursor on (host, repo, pr_number) so a re-opened/re-run PR updates in place rather than
// accreting duplicates. Resets the live loop fields (status='open', iteration=0) — a freshly opened
// PR starts the loop from the top.
// A cursor row as the loop reads it (subset of columns it acts on).
export interface CursorRow {
  id: string;
  host: string;
  repo: string;
  pr_number: number;
  head_ref: string;
  base_ref: string;
  stack: string | null;
  cwd: string;
  node_id: string;
  task_prompt: string | null;
  iteration: number;
  escalations: number;
  last_commit_sha: string | null;
  user_id: string | null;
  status: string;
  last_input_sig: string | null;
  no_progress_passes: number;
  last_unresolved: number | null;
}

export async function seedCursor(db: Db, o: SeedCursorOpts): Promise<void> {
  await db.query(
    `insert into sage.pr_iterations
       (host, repo, pr_number, head_ref, base_ref, stack, cwd, task_prompt, node_id, status, iteration, last_commit_sha, user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',0,$10,$11)
     on conflict (host, repo, pr_number) do update set
       head_ref = excluded.head_ref,
       base_ref = excluded.base_ref,
       stack = excluded.stack,
       cwd = excluded.cwd,
       task_prompt = excluded.task_prompt,
       node_id = excluded.node_id,
       status = 'open',
       iteration = 0,
       escalations = 0,
       paused = false,
       last_commit_sha = excluded.last_commit_sha,
       user_id = excluded.user_id,
       updated_at = now()`,
    [o.host, o.repo, o.prNumber, o.headRef, o.baseRef, o.stack, o.cwd, o.taskPrompt, o.nodeId, o.lastCommitSha, o.userId],
  );
}

// ── The loop's cursor state machine (005 §7) ────────────────────────────────────

// Reset `iterating` rows older than the stale window back to `open`, freeing the concurrency slot a
// crashed node left held. The window must exceed a fix's hard cap or a live iteration gets yanked.
export async function reclaimStale(db: Db, staleInterval: string): Promise<number> {
  const r = await db.query(
    `update sage.pr_iterations set status='open', claimed_at=null, updated_at=now()
       where status='iterating' and claimed_at < now() - ($1::text)::interval`,
    [staleInterval],
  );
  if (r.rowCount) console.warn(`[sage] reclaimed ${r.rowCount} stale iterating row(s)`);
  return r.rowCount ?? 0;
}

// Candidate cursors this node can act on: open|waiting, not paused, oldest-touched first.
export async function selectOpenForNode(db: Db, nodeId: string, limit = 20): Promise<CursorRow[]> {
  const r = await db.query(
    `select id, host, repo, pr_number, head_ref, base_ref, stack, cwd, node_id, task_prompt,
            iteration, escalations, last_commit_sha, user_id, status, last_input_sig,
            no_progress_passes, last_unresolved
       from sage.pr_iterations
       where node_id=$1 and status in ('open','waiting') and not paused
       order by updated_at asc limit $2`,
    [nodeId, limit],
  );
  return r.rows as CursorRow[];
}

// Atomically flip open → iterating iff under the global cap. The count subquery + status guard run
// in one statement so the cap holds across instances.
export async function tryClaimIterating(db: Db, rowId: string, concurrency: number): Promise<boolean> {
  const r = await db.query(
    `update sage.pr_iterations set status='iterating', claimed_at=now(), updated_at=now()
       where id=$1 and status='open'
         and (select count(*) from sage.pr_iterations where status='iterating') < $2
       returning id`,
    [rowId, concurrency],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function advance(
  db: Db,
  opts: { rowId: string; status: string; iteration?: number | null; lastCommitSha?: string | null; escalationsDelta?: number },
): Promise<void> {
  await db.query(
    `update sage.pr_iterations
       set status=$2,
           iteration=coalesce($3, iteration),
           last_commit_sha=coalesce($4, last_commit_sha),
           escalations=escalations + $5,
           claimed_at=null, updated_at=now()
       where id=$1`,
    [opts.rowId, opts.status, opts.iteration ?? null, opts.lastCommitSha ?? null, opts.escalationsDelta ?? 0],
  );
}

export async function markWaiting(db: Db, opts: { rowId: string; lastInputSig: string; escalationsDelta?: number }): Promise<void> {
  await db.query(
    `update sage.pr_iterations set status='waiting', last_input_sig=$2,
       escalations=escalations + $3, claimed_at=null, updated_at=now() where id=$1`,
    [opts.rowId, opts.lastInputSig, opts.escalationsDelta ?? 0],
  );
}

export async function rearm(db: Db, rowId: string): Promise<void> {
  await db.query(
    `update sage.pr_iterations set status='open', iteration=0, no_progress_passes=0,
       last_unresolved=null, last_input_sig=null, claimed_at=null, updated_at=now() where id=$1`,
    [rowId],
  );
}

export async function updateProgress(
  db: Db,
  opts: { rowId: string; noProgressPasses: number; lastUnresolved: number; lastInputSig: string },
): Promise<void> {
  await db.query(
    `update sage.pr_iterations set no_progress_passes=$2, last_unresolved=$3, last_input_sig=$4, updated_at=now() where id=$1`,
    [opts.rowId, opts.noProgressPasses, opts.lastUnresolved, opts.lastInputSig],
  );
}
