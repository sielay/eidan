// SPDX-License-Identifier: AGPL-3.0-or-later
// PR-state reconciler. Mirror each settled `code` job's PR state from GitHub back onto the job
// (eidan.jobs.result.pr_state), so the board's lifecycle phase reflects reality WITHOUT the operator
// touching it: a PR merged by ANYONE (human or another agent) = review done → Done; a closed-unmerged
// or CI-failing PR = Needs work. This is the passive half of PR communication — the iteration loop is
// the active half (it reads reviews/threads and pushes fixes). The web board reads `result.pr_state`.
import type { Db } from './db.js';
import { loadConfig } from './config.js';
import { routePat, type PatEntry } from './pats.js';
import { prStatus, checks } from './gh.js';
import type { Notify } from './pipeline.js';

const PR_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;
// gh `pr checks` buckets: pass | fail | pending | skipping | cancel. Treat these as a failing rollup.
const FAILING_BUCKETS = new Set(['fail', 'cancel', 'failure', 'error', 'timed_out']);

export function startPrReconcile(db: Db, pats: PatEntry[], notify: Notify): () => void {
  const cfg = loadConfig();
  const resolvePat = (opts: { host: string; ownerRepo: string; scope: 'read' | 'write' }): string | null =>
    routePat(pats, opts)?.token ?? null;
  let stopped = false;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

  // Resolve a single job's PR state and persist it if it changed.
  const reconcileOne = async (id: string, result: Record<string, unknown>): Promise<void> => {
    const url = (result['prUrl'] ?? result['pr_url']) as unknown;
    if (typeof url !== 'string') return;
    const m = PR_RE.exec(url);
    if (!m) return;
    const [, owner, repo, num] = m;
    const ownerRepo = `${owner}/${repo}`;
    if (!resolvePat({ host: 'github.com', ownerRepo, scope: 'read' })) return; // no PAT for this repo — skip

    let next: 'merged' | 'closed' | 'ci_failed' | 'open';
    try {
      const st = await prStatus(resolvePat, { host: 'github.com', ownerRepo, number: Number(num) });
      if (st.state === 'MERGED') next = 'merged';
      else if (st.state === 'CLOSED') next = 'closed';
      else {
        const ci = await checks(resolvePat, { host: 'github.com', ownerRepo, number: Number(num) });
        const failing = ci.allSettled && ci.checks.some((c) => FAILING_BUCKETS.has((c.bucket ?? c.state ?? '').toLowerCase()));
        next = failing ? 'ci_failed' : 'open';
      }
    } catch {
      return; // transient GitHub/network error — leave it for the next tick
    }

    const prev = typeof result['pr_state'] === 'string' ? (result['pr_state'] as string) : null;
    if (prev === next) return;
    await db.query(
      `update eidan.jobs
         set result = coalesce(result, '{}'::jsonb) || jsonb_build_object('pr_state', $2::text, 'pr_checked_at', now()::text),
             updated_at = now()
       where id = $1`,
      [id, next],
    );
    if (next === 'merged') await notify(`✅ ${ownerRepo}#${num} merged — job done: ${url}`);
    else if (next === 'ci_failed') await notify(`🔴 ${ownerRepo}#${num} CI failing — needs work: ${url}`, 'warn');
    else if (next === 'closed') await notify(`⛔ ${ownerRepo}#${num} closed unmerged — needs work: ${url}`, 'warn');
  };

  // One pass over settled jobs that opened a PR and haven't reached a terminal state yet.
  const tick = async (): Promise<void> => {
    const r = await db.query(
      `select id, result from eidan.jobs
        where status = 'done' and kind = 'code'
          and coalesce(result->>'prUrl', result->>'pr_url') is not null
          and coalesce(result->>'pr_state', '') not in ('merged', 'closed')
        order by updated_at desc
        limit 100`,
    );
    for (const row of r.rows as Array<{ id: string; result: Record<string, unknown> | null }>) {
      if (stopped) return;
      await reconcileOne(row.id, row.result ?? {});
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        console.warn(`[sage] reconcile tick error: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(cfg.pollIntervalMs);
    }
  };
  void loop();
  console.log(`[sage] PR-reconcile poll started (every ${Math.round(cfg.pollIntervalMs / 1000)}s — merged→done, ci-fail/closed→needs-work)`);
  return () => { stopped = true; };
}
