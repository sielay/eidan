// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture → persist → route. The one deterministic auto-action is opening a sage `code` job for a
// bug/task that names a routable repo (via codeJobTarget). Content-shaped routing (blog/journey
// cards) is intentionally NOT here — it's left to the scheduled planning agents, which read the
// journal and use their own tools, so this plugin never reaches into another plugin's schema.
import type { JournalDb, CaptureInput } from './db.js';
import type { JournalEntry } from './types.js';
import { codeJobTarget } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RouteResult {
  entry: JournalEntry;
  job_id: string | null;
  routed: 'code_job' | 'logged';
}

// Compose the full-task brief a code worker (sage) runs from — it works from this, not a GitHub
// issue body, so fold in everything the note carried.
function jobGoal(entry: JournalEntry): string {
  const lines = [entry.summary];
  if (entry.body && entry.body.trim()) lines.push('', entry.body.trim());
  lines.push('', `(Filed from the operator's journal as a ${entry.entry_type}${entry.project ? ` on ${entry.project}` : ''}.)`);
  return lines.join('\n');
}

export async function captureAndRoute(db: JournalDb, principalId: string, input: CaptureInput): Promise<RouteResult | null> {
  const entry = await db.insertEntry(input);
  if (!entry) return null;

  const repo = codeJobTarget(entry.entry_type, entry.target_repo);
  if (!repo) return { entry, job_id: null, routed: 'logged' };

  const userId = UUID_RE.test(principalId) ? principalId : null;
  const requestedBy = userId ? null : principalId;
  const jobId = await db.enqueueCodeJob(userId, requestedBy, jobGoal(entry), {
    repo,
    stack: 'sage',
    title: entry.summary.slice(0, 120),
    journal_entry_id: entry.id,
  });
  if (jobId) {
    await db.stampJob(entry.id, jobId);
    return { entry: { ...entry, job_id: jobId }, job_id: jobId, routed: 'code_job' };
  }
  return { entry, job_id: null, routed: 'logged' };
}
