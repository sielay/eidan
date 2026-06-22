// SPDX-License-Identifier: AGPL-3.0-or-later
// Sage's admin "cursor panel" — the data behind the operator's PR-queue board. Core's CursorsPane
// (apps/web) is plugin-agnostic: it discovers panel prefixes via /api/admin/panels and renders
// whatever serves the conventional `cursors` + `summary` shape. This module builds that shape from
// sage.pr_iterations + sage.review_findings; panel-server.ts serves it over HTTP. The rich per-PR
// bits the board shows (findings by severity, iteration timeline) ride in each cursor's generic
// `detail` bag, so core needs no sage-specific knowledge.
import type { Db } from './db.js';

// The exact contract core/apps/web expects (lib/api/admin.ts).
export interface CursorItem {
  id: string;
  title: string;
  url: string | null;
  status: string;
  paused: boolean;
  node_id: string | null;
  detail: Record<string, unknown>;
  actions: string[];
}
export interface CursorPanel { provider: string; label: string; kind: string; cursors: CursorItem[] }
export interface ProviderSummary { provider: string; label: string; stats: { label: string; value: number }[]; by_status: Record<string, number> }

const PROVIDER = 'sage';
const LABEL = 'Sage · dev loop';

// review_findings.severity → the board's blocker/warning/nit zones.
const SEV_MAP: Record<string, 'blocker' | 'warning' | 'nit'> = { error: 'blocker', warning: 'warning', note: 'nit' };

interface IterRow {
  id: string; host: string; repo: string; pr_number: number; head_ref: string; base_ref: string;
  status: string; iteration: number; escalations: number; node_id: string | null; paused: boolean;
  last_commit_sha: string | null; updated_at: string;
}
interface FindingRow { pr_number: number; severity: string; kind: string | null; file: string | null; line: number | null; message: string; outcome: string; commit_sha: string | null; created_at: string }

function prUrl(host: string, repo: string, n: number): string {
  return `https://${host}/${repo}/pull/${n}`;
}

function relTime(iso: string): string {
  // The board only needs a short human label; compute coarse buckets without Date.now games.
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// Build the findings detail for one PR from its review_findings rows: per-severity counts + the
// flat list the detail pane renders, plus a coarse iteration timeline derived from the rows.
function buildFindingDetail(rows: FindingRow[]): { counts: Record<string, number>; findings: unknown[]; timeline: unknown[] } {
  const counts: Record<string, number> = { blocker: 0, warning: 0, nit: 0 };
  const findings: unknown[] = [];
  for (const r of rows) {
    // Skip sentinel/no-message audit rows; only surface real findings.
    if (!r.file && /^<.*>$/.test(r.message)) continue;
    const sev = SEV_MAP[r.severity] ?? 'nit';
    counts[sev] = (counts[sev] ?? 0) + 1;
    findings.push({ sev, file: r.file ? `${r.file}${r.line ? `:${r.line}` : ''}` : (r.kind ?? '—'), msg: r.message, outcome: r.outcome });
  }
  // Timeline: one entry per distinct commit_sha (an iteration), newest first, with its finding count.
  const byCommit = new Map<string, { when: string; n: number }>();
  for (const r of rows) {
    const key = r.commit_sha ?? 'initial';
    const e = byCommit.get(key) ?? { when: r.created_at, n: 0 };
    e.n += 1;
    if (r.created_at > e.when) e.when = r.created_at;
    byCommit.set(key, e);
  }
  const timeline = [...byCommit.entries()]
    .sort((a, b) => (a[1].when < b[1].when ? 1 : -1))
    .map(([sha, e], i, arr) => ({ n: arr.length - i, when: relTime(e.when), text: `${e.n} finding(s)${sha === 'initial' ? '' : ` · ${sha.slice(0, 10)}`}` }));
  return { counts, findings, timeline };
}

export async function buildPanel(db: Db, nodeId?: string): Promise<CursorPanel> {
  const where = nodeId ? 'where node_id = $1' : '';
  const iters = await db.query(
    `select id, host, repo, pr_number, head_ref, base_ref, status, iteration, escalations,
            node_id, paused, last_commit_sha, updated_at
       from sage.pr_iterations ${where}
       order by updated_at desc limit 200`,
    nodeId ? [nodeId] : [],
  );
  const rows = iters.rows as IterRow[];
  if (!rows.length) return { provider: PROVIDER, label: LABEL, kind: 'code', cursors: [] };

  // One findings query for all shown PRs, grouped in memory.
  const prNums = rows.map((r) => r.pr_number);
  const f = await db.query(
    `select pr_number, severity, kind, file, line, message, outcome, commit_sha, created_at
       from sage.review_findings where pr_number = any($1::int[]) order by created_at asc`,
    [prNums],
  );
  const findingsByPr = new Map<number, FindingRow[]>();
  for (const r of f.rows as FindingRow[]) {
    const arr = findingsByPr.get(r.pr_number) ?? [];
    arr.push(r);
    findingsByPr.set(r.pr_number, arr);
  }

  const cursors: CursorItem[] = rows.map((r) => {
    const fd = buildFindingDetail(findingsByPr.get(r.pr_number) ?? []);
    return {
      id: r.id,
      title: `${r.repo} #${r.pr_number}`,
      url: prUrl(r.host, r.repo, r.pr_number),
      status: r.status,
      paused: r.paused,
      node_id: r.node_id,
      actions: [r.paused ? 'resume' : 'pause'],
      detail: {
        repo: r.repo,
        pr_number: r.pr_number,
        branch: r.head_ref,
        base: r.base_ref,
        iteration: r.iteration,
        escalations: r.escalations,
        updated: relTime(r.updated_at),
        last_commit: r.last_commit_sha,
        findingCounts: fd.counts,
        findings: fd.findings,
        timeline: fd.timeline,
      },
    };
  });
  return { provider: PROVIDER, label: LABEL, kind: 'code', cursors };
}

export async function buildSummary(db: Db, nodeId?: string): Promise<ProviderSummary> {
  const where = nodeId ? 'where node_id = $1' : '';
  const r = await db.query(
    `select status, count(*)::int as n, count(*) filter (where paused)::int as paused_n
       from sage.pr_iterations ${where} group by status`,
    nodeId ? [nodeId] : [],
  );
  const by_status: Record<string, number> = {};
  let open = 0;
  let needsYou = 0;
  for (const row of r.rows as { status: string; n: number; paused_n: number }[]) {
    by_status[row.status] = row.n;
    if (row.status !== 'done' && row.status !== 'exhausted') open += row.n;
    if (row.status === 'escalated' || row.status === 'waiting') needsYou += row.n;
  }
  return {
    provider: PROVIDER,
    label: LABEL,
    stats: [
      { label: 'Open PRs', value: open },
      { label: 'Needs you', value: needsYou },
    ],
    by_status,
  };
}

// pause/resume an individual cursor (the board's action buttons). resume re-arms the parked loop.
export async function runCursorAction(db: Db, cursorId: string, action: string): Promise<{ ok: boolean }> {
  if (action === 'pause') {
    await db.query(`update sage.pr_iterations set paused = true, updated_at = now() where id = $1`, [cursorId]);
    return { ok: true };
  }
  if (action === 'resume') {
    // Clear the pause AND re-arm (status→open, fresh budget) so the loop picks it back up.
    await db.query(
      `update sage.pr_iterations set paused = false, status = 'open', iteration = 0,
         no_progress_passes = 0, last_unresolved = null, last_input_sig = null,
         claimed_at = null, updated_at = now() where id = $1`,
      [cursorId],
    );
    return { ok: true };
  }
  throw new Error(`unknown action: ${action}`);
}
