// SPDX-License-Identifier: AGPL-3.0-or-later
// Audit-row writer for sage.review_findings — port of findings.insert_iteration_findings. One row
// per triaged iteration item: what Copilot/CI raised, how sage classified it, which commit resolved
// it. Best-effort: the push already happened, so a DB hiccup must not fail the loop into a retry.
import type { Db } from './db.js';

export interface FindingItem {
  verdict: string;
  kind: string | null;
  file: string | null;
  line: number | null;
  message: string | null;
  suggestedFix: string | null;
}

// Triage verdict → review_findings.outcome. `addressed` = fixed in a follow-up commit; `escalated`
// = handed to the operator (a distinct outcome — never overload an existing sentinel, 005 §5.2).
const VERDICT_OUTCOME: Record<string, string> = {
  fix: 'addressed',
  autofix: 'addressed',
  reply: 'noted',
  ack: 'noted',
  escalate: 'escalated',
};

export async function insertIterationFindings(
  db: Db,
  opts: { host: string; repo: string; headRef: string; baseRef: string; prNumber: number; commitSha: string | null; items: FindingItem[] },
): Promise<number> {
  if (!opts.items.length) return 0;
  // severity is fixed to 'note' — an iteration row records what sage DID, not a fresh severity
  // judgement (the critic owns severity).
  const values: unknown[] = [];
  const tuples: string[] = [];
  opts.items.forEach((it, i) => {
    const b = i * 13;
    tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`);
    const verdict = (it.verdict ?? '').trim().toLowerCase();
    values.push(
      opts.host, opts.repo, opts.headRef, opts.baseRef, opts.prNumber,
      'note', it.kind, it.file, it.line,
      (it.message ?? '').trim() || '<no message>', it.suggestedFix,
      VERDICT_OUTCOME[verdict] ?? 'noted', opts.commitSha,
    );
  });
  try {
    await db.query(
      `insert into sage.review_findings
         (host, repo, head_ref, base_ref, pr_number, severity, kind, file, line, message, suggested_fix, outcome, commit_sha)
       values ${tuples.join(',')}`,
      values,
    );
  } catch (e) {
    console.warn(`[sage] insertIterationFindings failed for ${opts.host}:${opts.repo}#${opts.prNumber}: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  return opts.items.length;
}
