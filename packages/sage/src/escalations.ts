// SPDX-License-Identifier: AGPL-3.0-or-later
// Write the iteration loop's escalations to core's eidan.escalations inbox (the operator's
// escalation view) — port of the Python EscalationContext. The loop runs against the same Postgres
// as core, so this is a direct INSERT. None-safe + never throws: a job with no user_id (escalations
// are user-scoped) or a DB hiccup is logged and skipped — the PR comment + cursor state already
// recorded the escalation locally, so the inbox write is a best-effort mirror.
import type { Db } from './db.js';
import type { Escalate } from './iteration.js';

// eidan.escalations CHECK-constrained enums (core migrations/sql/0001_baseline.sql):
//   severity ∈ {low, medium, high}; reason_class ∈ {missing_input, permission_denied,
//   external_failure, ambiguous_intent, over_budget, over_capacity, no_progress,
//   unrecoverable_error, other}; status defaults 'pending'.
const VALID_REASONS = new Set([
  'missing_input', 'permission_denied', 'external_failure', 'ambiguous_intent',
  'over_budget', 'over_capacity', 'no_progress', 'unrecoverable_error', 'other',
]);

export function makeEscalate(db: Db): Escalate {
  return async (o) => {
    if (!o.userId) return; // escalations are user-scoped (user_id is NOT NULL); nothing to mirror
    const reasonClass = o.reasonClass && VALID_REASONS.has(o.reasonClass) ? o.reasonClass : 'ambiguous_intent';
    const evidence = [o.prUrl, ...o.threadIds].filter(Boolean);
    const metadata = { repo: o.repo, pr_number: o.prNumber, head_ref: o.headRef, node_id: o.nodeId };
    try {
      await db.query(
        `insert into eidan.escalations (user_id, severity, reason_class, suggested_action, evidence, metadata)
         values ($1, 'medium', $2, $3, $4::jsonb, $5::jsonb)`,
        [o.userId, reasonClass, o.reason, JSON.stringify(evidence), JSON.stringify(metadata)],
      );
    } catch (e) {
      console.warn(`[sage] eidan.escalations write failed for ${o.repo}#${o.prNumber}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
