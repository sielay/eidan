// SPDX-License-Identifier: AGPL-3.0-or-later
// The PR-iteration loop — port of iteration.py (005 §7). One settled, sage-managed PR at a time:
// triage the Copilot threads + failing checks, apply the agreed fixes via `claude`, push them,
// resolve the threads sage addressed, advance the cursor. The loop spans ticks: after a push the PR
// goes un-settled (CI re-runs, Copilot re-reviews); the next tick that finds it settled iterates
// again or terminates it.
//
// NOTE: the self-review fallback (Copilot never engages → cheap-model verdict) is Brick 3. Until
// then, a Copilot-less PR simply waits (returns 'not_settled'), exactly as the Python loop does when
// cfg.selfreview is None.
import { runClaude } from './claude.js';
import {
  preparePrWorkspace, commitAll, pushBranch, releaseWorkspace, currentHeadSha,
  type PatResolver, type PreparedWorkspace,
} from './git.js';
import * as gh from './gh.js';
import { loadDiff } from './diff.js';
import { render, parseVerdicts, COPILOT_VERDICTS, CI_VERDICTS, type Verdict } from './triage.js';
import { TRIAGE_COPILOT_TEMPLATE, TRIAGE_CI_TEMPLATE } from './prompts.js';
import { insertIterationFindings, type FindingItem } from './findings.js';
import * as track from './tracking.js';
import type { CursorRow } from './tracking.js';
import type { Db } from './db.js';
import type { SageConfig } from './config.js';
import { runSelfReview, blockingConcerns, type SelfReviewConfig } from './selfreview.js';
import type { Concern } from './critic.js';

// Optional escalation sink — mirrors a paused/escalated PR to the operator's inbox. Brick 2 makes it
// optional (no-op when absent); a real eidan.escalations writer can be wired later.
export type Escalate = (opts: {
  userId: string | null; repo: string; prNumber: number; headRef: string; nodeId: string;
  reason: string; prUrl: string; threadIds: string[];
  // eidan.escalations reason_class. Defaults to 'ambiguous_intent' (a judgement call sage couldn't
  // make); the stall-to-waiting path passes 'no_progress'.
  reasonClass?: string | undefined;
}) => Promise<void>;

export type Notify = (text: string, severity?: string) => Promise<void>;

export interface IterationDeps {
  db: Db;
  cfg: SageConfig;
  resolvePat: PatResolver;
  notify: Notify;
  escalate?: Escalate | undefined;
  // The OpenRouter cheap-model self-review fallback (Brick 3). null → the loop keeps waiting for
  // Copilot when it doesn't engage, exactly as the Python loop does when cfg.selfreview is None.
  selfreview?: SelfReviewConfig | null | undefined;
}

const COPILOT_LOGIN = 'copilot-pull-request-reviewer[bot]';
const FAIL_STATES = new Set(['failure', 'timed_out', 'action_required', 'error', 'startup_failure']);

// ── pure predicates + renderers (no IO) ─────────────────────────────────────────

function isCopilot(login: string | null | undefined): boolean {
  if (!login) return false;
  const low = login.toLowerCase();
  return low === COPILOT_LOGIN || low.startsWith('copilot');
}

export function copilotSubmitted(reviews: unknown[]): boolean {
  for (const r of reviews) {
    if (!r || typeof r !== 'object') continue;
    const rr = r as Record<string, unknown>;
    const author = (rr['author'] as Record<string, unknown>) ?? {};
    if (isCopilot(author['login'] as string) && String(rr['state'] ?? '').toUpperCase() !== 'PENDING') return true;
  }
  return false;
}

export function copilotPending(requested: unknown[]): boolean {
  for (const r of requested) {
    if (!r || typeof r !== 'object') continue;
    if (isCopilot((r as Record<string, unknown>)['login'] as string)) return true;
  }
  return false;
}

export function failingChecks(checks: gh.CheckRow[]): gh.CheckRow[] {
  return checks.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    const bucket = (c.bucket ?? '').toLowerCase();
    const state = (c.state ?? '').toLowerCase();
    return bucket === 'fail' || (!bucket && FAIL_STATES.has(state));
  });
}

export function openThreads(threads: gh.ReviewThread[]): gh.ReviewThread[] {
  return threads.filter((t) => t && typeof t === 'object' && !t.is_resolved);
}

// Sage's own PR comments start with these emoji markers (see the iteration/terminal/waiting/self-review
// comment templates). Used both to skip them as 'operator feedback' and as the addressed-watermark.
function isSageComment(body: string): boolean {
  const b = body.trimStart();
  return b.startsWith('🤖') || b.startsWith('🛑');
}

// Operator instructions: human (non-bot, non-sage) PR conversation comments posted SINCE sage's last
// comment. Sage addresses these alongside Copilot threads; its next comment re-watermarks them as
// handled, so a comment is acted on once and doesn't re-trigger.
export function unaddressedOperatorComments(comments: gh.PrComment[]): gh.PrComment[] {
  let watermark = '';
  for (const c of comments) if (isSageComment(c.body) && c.createdAt > watermark) watermark = c.createdAt;
  return comments.filter((c) => !c.isBot && !isSageComment(c.body) && c.createdAt > watermark);
}

export function shouldTerminate(open: gh.ReviewThread[], failing: gh.CheckRow[], operator: gh.PrComment[] = []): boolean {
  return open.length === 0 && failing.length === 0 && operator.length === 0;
}

function renderThreadsBlock(open: gh.ReviewThread[]): string {
  if (!open.length) return '(no open threads)';
  const lines: string[] = [];
  for (const t of open) {
    lines.push(`- thread_id: ${t.id}`);
    lines.push(`  path: ${t.path ? t.path : '(PR-level, no file)'}`);
    lines.push('  comments:');
    for (const c of t.comments ?? []) {
      const author = c.author ?? '(unknown)';
      const body = String(c.body ?? '').trim().replace(/\n/g, '\n      ');
      lines.push(`    - [${author}] ${body}`);
    }
  }
  return lines.join('\n');
}

function renderChecksBlock(failing: gh.CheckRow[]): string {
  if (!failing.length) return '(no failing checks)';
  const lines: string[] = [];
  for (const c of failing) {
    lines.push(`- check: ${c.name}`);
    lines.push(`  workflow: ${c.workflow ?? '(none)'}`);
    lines.push(`  state: ${c.state ?? c.bucket ?? '(unknown)'}`);
    if (c.link) lines.push(`  link: ${c.link}`);
  }
  return lines.join('\n');
}

function composeFixPrompt(opts: {
  taskPrompt: string; prNumber: number; copilotFixes: Verdict[]; ciFixes: Verdict[]; threadsById: Map<string, gh.ReviewThread>;
  operator?: gh.PrComment[];
}): string {
  const lines = [
    "You are sage's PR-iteration fixer. Apply ONLY the changes listed below to the current working tree.",
    '',
    'Hard rules:',
    '- Do NOT commit, push, amend, or create branches — sage does that after you return. Just edit the files.',
    '- Never use `--no-verify`, never delete or xfail a test, never disable a hook to make something pass.',
    '- Keep the changes minimal and scoped to the items below.',
    "- Follow the repo's CLAUDE.md \"Common failure modes\": for any apps/web change run `cd apps/web && pnpm run typecheck`; never rewrite pnpm-lock.yaml unless you changed deps; never put backslashes in file paths (escaped Next route segments); Postgres has no `ADD CONSTRAINT IF NOT EXISTS`.",
    '',
    `This is PR #${opts.prNumber}. What the PR set out to do:`,
    opts.taskPrompt || '(no task prompt recorded)',
    '',
  ];
  if (opts.copilotFixes.length) {
    lines.push('## Copilot review comments to address');
    for (const v of opts.copilotFixes) {
      const thread = opts.threadsById.get(v.ref);
      const path = thread?.path ?? '(no file)';
      const comment = (thread?.comments ?? []).find((c) => c.body)?.body?.trim() ?? '';
      lines.push(`- [${path}] reviewer said: ${comment}`);
      if (v.fixHint) lines.push(`  → fix: ${v.fixHint}`);
    }
    lines.push('');
  }
  if (opts.ciFixes.length) {
    lines.push('## Failing checks to fix');
    for (const v of opts.ciFixes) {
      const tag = v.verdict === 'autofix' ? 'autofix' : 'fix';
      lines.push(`- [${tag}] ${v.ref}: ${v.fixHint ?? v.reason}`);
    }
    lines.push('');
  }
  if (opts.operator?.length) {
    lines.push('## Operator instructions (PR comments) to address');
    lines.push('Direct guidance from the human operator on this PR — apply what they ask (edit the code accordingly). If a comment is a question or not actionable, do nothing for it.');
    for (const c of opts.operator) {
      const body = String(c.body).trim().replace(/\n/g, '\n  ');
      lines.push(`- [${c.author ?? 'operator'}] ${body}`);
    }
    lines.push('');
  }
  lines.push('When done, stop. Do not summarise — sage reads the diff, not your final message.');
  return lines.join('\n');
}

function commitMessage(opts: { prNumber: number; iteration: number; copilotFixes: Verdict[]; ciFixes: Verdict[] }): string {
  const n = opts.copilotFixes.length + opts.ciFixes.length;
  const head = `fix: address PR #${opts.prNumber} review (iteration ${opts.iteration}, ${n} item(s))`;
  const body: string[] = [];
  for (const v of opts.copilotFixes) body.push(`- review: ${(v.fixHint ?? v.reason) || ''}`.trimEnd());
  for (const v of opts.ciFixes) body.push(`- ci: ${(v.fixHint ?? v.reason) || ''}`.trimEnd());
  return body.length ? `${head}\n\n${body.join('\n')}` : head;
}

function iterationComment(opts: {
  iteration: number; commitSha: string | null; copilotFixes: Verdict[]; ciFixes: Verdict[];
  replies: Verdict[]; acks: Verdict[]; escalations: Verdict[]; operatorCount?: number;
}): string {
  const sha = opts.commitSha ? ` in \`${opts.commitSha.slice(0, 10)}\`` : '';
  const parts = [`🤖 **Sage iteration ${opts.iteration}**`];
  if (opts.copilotFixes.length || opts.ciFixes.length) parts.push(`- Fixed ${opts.copilotFixes.length + opts.ciFixes.length} item(s)${sha}.`);
  if (opts.operatorCount) parts.push(`- Addressed ${opts.operatorCount} operator comment(s)${sha}.`);
  if (opts.replies.length) parts.push(`- Replied (kept current approach) on ${opts.replies.length} thread(s).`);
  if (opts.acks.length) parts.push(`- Acknowledged ${opts.acks.length} informational comment(s).`);
  if (opts.escalations.length) parts.push(`- ⚠️ Escalated ${opts.escalations.length} item(s) — needs a human decision; the loop is paused on this PR.`);
  return parts.join('\n');
}

function terminalComment(clean: boolean, iteration: number): string {
  return clean
    ? `🤖 **Sage:** all Copilot threads resolved and CI is green after ${iteration} iteration(s). Ready for human review / merge — sage does not auto-merge.`
    : `🤖 **Sage:** stopped after ${iteration} iteration(s) (\`EIDAN_SAGE_LOOP_MAX_ITERATIONS\`) without fully converging. Handing back to a human.`;
}

function waitingComment(iteration: number, maxIterations: number): string {
  return `🛑 **Sage paused** after ${iteration} iteration(s) (cap ${maxIterations}) without fully converging — escalated to the operator. The loop **resumes automatically** on new activity here (a new commit, a review, or your feedback). No manual reset needed.`;
}

// A stable signature of the PR's review + check state (eidan-sage#64). Changes when a review is
// added/updated or checks re-run; constant while nothing happens. A parked `waiting` cursor re-arms
// exactly when this differs from the value recorded at park time.
function inputSignature(reviews: gh.ReviewsPayload, checks: gh.ChecksPayload): string {
  const rev = (reviews.reviews as Array<Record<string, unknown>>)
    .map((r) => `${((r['author'] as Record<string, unknown>)?.['login'] as string) ?? ''}|${(r['state'] as string) ?? ''}|${(r['submittedAt'] as string) ?? ''}`)
    .sort();
  const chk = checks.checks
    .map((c) => `${c.name ?? ''}|${c.bucket ?? c.state ?? ''}|${c.completedAt ?? ''}|${c.startedAt ?? ''}`)
    .sort();
  return `R:${rev.join(';')}||C:${chk.join(';')}`;
}

function nextNoProgress(row: CursorRow, sig: string, unresolved: number): number {
  const prev = row.last_unresolved;
  const improved = prev !== null && prev !== undefined && unresolved < prev;
  const newInput = sig !== (row.last_input_sig ?? '');
  if (improved || newInput) return 0;
  return (row.no_progress_passes ?? 0) + 1;
}

function deriveStack(cwd: string, stored: string | null): string {
  if (stored) return stored;
  return cwd.split('/').filter(Boolean).pop() ?? 'sage';
}

function verdictsToItems(verdicts: Verdict[], kind: string): FindingItem[] {
  return verdicts.map((v) => ({
    verdict: v.verdict, kind, file: null, line: null,
    message: v.reason || v.fixHint || v.ref, suggestedFix: v.fixHint,
  }));
}

// ── orchestration (IO) ──────────────────────────────────────────────────────────

async function runClaudeStep(deps: IterationDeps, prompt: string, cwd: string, model: string | undefined): Promise<ReturnType<typeof runClaude>> {
  const { cfg } = deps;
  return runClaude({
    binPath: cfg.claudeBinPath!,
    prompt, cwd, model,
    oauthToken: cfg.oauthToken,
    system: cfg.ponytailSystem,
    pluginDir: cfg.ponytailDir ?? undefined,
    ponytailMode: cfg.ponytailMode,
    inactivityTimeoutMs: cfg.inactivityTimeoutMs,
    hardCapMs: cfg.hardCapMs,
    maxOutputTail: cfg.maxOutputTail,
  });
}

// One sage:pr_iteration firing. Reclaims stale slots, walks this node's open cursors, runs read-only
// settle/termination first (no slot spent); only a PR that needs work claims a concurrency slot.
// Returns iterations run.
export async function runTick(deps: IterationDeps): Promise<number> {
  const { db, cfg } = deps;
  if (cfg.claudeBinPath === null) return 0; // no fixer on this node — pr_iteration is a no-op here
  await track.reclaimStale(db, cfg.staleInterval);
  const candidates = await track.selectOpenForNode(db, cfg.nodeId);
  let iterationsRun = 0;
  for (const row of candidates) {
    const outcome = await evaluateAndIterate(deps, row);
    if (['done', 'exhausted', 'escalated', 'waiting'].includes(outcome)) await notifyMilestone(deps, row, outcome);
    if (outcome === 'iterated' || outcome === 'escalated') {
      iterationsRun += 1;
      if (iterationsRun >= cfg.concurrency) break;
    } else if (outcome === 'no_slot') {
      break;
    }
  }
  return iterationsRun;
}

async function notifyMilestone(deps: IterationDeps, row: CursorRow, outcome: string): Promise<void> {
  const severity = ['exhausted', 'escalated', 'waiting'].includes(outcome) ? 'warn' : 'info';
  const pr = row.pr_number;
  const repo = row.repo;
  const messages: Record<string, string> = {
    done: `✅ Sage finished PR #${pr} on ${repo} — review threads resolved and CI green. Ready for a human to merge (sage never auto-merges).`,
    escalated: `⚠️ Sage paused on PR #${pr} on ${repo} — it flagged item(s) that need a human decision. The loop is held on this PR until someone steps in.`,
    exhausted: `🛑 Sage hit the iteration cap on PR #${pr} on ${repo} without fully converging — handing back to a human.`,
    waiting: `🛑 Sage paused PR #${pr} on ${repo} at the iteration cap and needs your input. It resumes automatically on new activity.`,
  };
  await deps.notify(messages[outcome] ?? `🤖 PR #${pr} on ${repo}: ${outcome}`, severity);
}

async function evaluateAndIterate(deps: IterationDeps, row: CursorRow): Promise<string> {
  const { db, cfg, resolvePat } = deps;
  const host = row.host;
  const ownerRepo = row.repo;
  const pr = row.pr_number;

  // Settle probe first (reviews + checks); also yields the input signature for #64 re-arm.
  let reviewsPayload: gh.ReviewsPayload;
  let checksPayload: gh.ChecksPayload;
  try {
    reviewsPayload = await gh.reviews(resolvePat, { host, ownerRepo, number: pr });
    checksPayload = await gh.checks(resolvePat, { host, ownerRepo, number: pr });
  } catch (e) {
    console.error(`[sage] settle probe failed for ${ownerRepo}#${pr}: ${e instanceof Error ? e.message : String(e)}`);
    return 'error';
  }
  // Operator instructions (plain PR conversation comments) drive iteration too, and must also wake a
  // parked `waiting` cursor — so fetch them now and fold them into the #64 input signature. Best-effort:
  // a comments-API hiccup must never wedge the loop.
  let operator: gh.PrComment[] = [];
  try {
    operator = unaddressedOperatorComments(await gh.prComments(resolvePat, { host, ownerRepo, number: pr }));
  } catch (e) {
    console.warn(`[sage] pr comments fetch failed for ${ownerRepo}#${pr}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const sig = inputSignature(reviewsPayload, checksPayload) + '||O:' + operator.map((c) => c.createdAt).sort().join(',');

  // #64 re-arm: a parked `waiting` cursor wakes only when its input signature changed.
  if (row.status === 'waiting') {
    if (sig === (row.last_input_sig ?? '')) return 'idle';
    await track.rearm(db, row.id);
    return 'rearmed';
  }

  if (!checksPayload.allSettled) return 'not_settled';

  const copilotDone = copilotSubmitted(reviewsPayload.reviews);
  if (!copilotDone && !operator.length) {
    // Copilot hasn't reviewed and there's no operator feedback to act on. Still a pending reviewer →
    // wait; never engaged + self-review configured → fall back (step 6); else keep waiting for Copilot.
    if (copilotPending(reviewsPayload.requested) || !deps.selfreview) return 'not_settled';
    return selfReviewPath(deps, row, failingChecks(checksPayload.checks), sig);
  }

  // Copilot threads only exist once Copilot reviewed; otherwise iterate on operator comments + CI.
  let threads: gh.ReviewThread[] = [];
  if (copilotDone) {
    try {
      threads = await gh.reviewThreads(resolvePat, { host, ownerRepo, number: pr });
    } catch (e) {
      console.error(`[sage] review_threads failed for ${ownerRepo}#${pr}: ${e instanceof Error ? e.message : String(e)}`);
      return 'error';
    }
  }

  const open = openThreads(threads);
  const failing = failingChecks(checksPayload.checks);

  // Clean termination — costs no slot.
  if (shouldTerminate(open, failing, operator)) {
    await commentSafe(deps, host, ownerRepo, pr, terminalComment(true, row.iteration));
    await track.advance(db, { rowId: row.id, status: 'done' });
    return 'done';
  }

  // Needs work. #64: track consecutive no-progress, park `waiting` at the cap instead of going deaf.
  const unresolved = open.length + failing.length + operator.length;
  const noProgress = nextNoProgress(row, sig, unresolved);
  await track.updateProgress(db, { rowId: row.id, noProgressPasses: noProgress, lastUnresolved: unresolved, lastInputSig: sig });
  if (noProgress >= cfg.maxIterations) {
    const reason = `made no progress for ${noProgress} consecutive pass(es) with ${open.length} open thread(s) and ${failing.length} failing check(s)`;
    return stallToWaiting(deps, row, sig, reason, open.map((t) => t.id).filter((x): x is string => !!x));
  }

  if (!(await track.tryClaimIterating(db, row.id, cfg.concurrency))) return 'no_slot';

  let prepared: PreparedWorkspace | null = null;
  try {
    prepared = await preparePrWorkspace(db, resolvePat, {
      host, owner: ownerRepo.split('/')[0]!, repo: ownerRepo.split('/')[1]!,
      stack: deriveStack(row.cwd, row.stack), nodeId: cfg.nodeId, headRef: row.head_ref,
    });
    if (prepared === null) {
      await track.advance(db, { rowId: row.id, status: 'open' });
      return 'lease_busy';
    }
    return await doIteration(deps, row, prepared, open, failing, operator);
  } catch (e) {
    console.error(`[sage] iteration failed for ${ownerRepo}#${pr}: ${e instanceof Error ? e.message : String(e)}`);
    await track.advance(db, { rowId: row.id, status: 'open' });
    return 'error';
  } finally {
    if (prepared !== null) {
      try {
        await releaseWorkspace(db, prepared);
      } catch (e) {
        console.warn(`[sage] lease release failed for ${ownerRepo}#${pr}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

// Compose a readable, actionable escalation for the operator inbox (it renders as markdown there). The
// inbox is the only place the operator sees sage's blockers, so it must be skimmable and END WITH A
// CLEAR QUESTION — never a wall of semicolon-joined review notes.
function formatItemsEscalation(repo: string, pr: number, items: Verdict[]): string {
  const lines = [
    `**Sage needs your decision on [${repo}#${pr}](https://github.com/${repo}/pull/${pr})** — ${items.length} review item(s) I couldn't resolve on my own:`,
    '',
  ];
  for (const v of items) {
    const ref = v.ref ? `\`${v.ref}\` — ` : '';
    lines.push(`- ${ref}${(v.reason || v.fixHint || '(no detail)').trim()}`);
  }
  lines.push('', "**What should I do for each?** Reply per item — *fix it* (with any guidance), *skip it*, or *change the approach* — and I'll resume this PR from your answer.");
  return lines.join('\n');
}

function formatStallEscalation(repo: string, pr: number, reason: string): string {
  return [
    `**Sage is stuck on [${repo}#${pr}](https://github.com/${repo}/pull/${pr}) and has paused.**`,
    '',
    `It ${reason}.`,
    '',
    "**How should I proceed?** e.g. give direction on the blockers, tell me to close/abandon the PR, or take it over — I'll resume from your answer.",
  ].join('\n');
}

async function stallToWaiting(deps: IterationDeps, row: CursorRow, sig: string, reason: string, threadIds: string[]): Promise<string> {
  const { db, cfg } = deps;
  const host = row.host;
  const ownerRepo = row.repo;
  const pr = row.pr_number;
  await commentSafe(deps, host, ownerRepo, pr, waitingComment(row.iteration, cfg.maxIterations));
  await escalateSafe(deps, row, formatStallEscalation(ownerRepo, pr, reason), threadIds, 'no_progress');
  await track.markWaiting(db, { rowId: row.id, lastInputSig: sig, escalationsDelta: 1 });
  return 'waiting';
}

async function doIteration(deps: IterationDeps, row: CursorRow, prepared: PreparedWorkspace, open: gh.ReviewThread[], failing: gh.CheckRow[], operator: gh.PrComment[] = []): Promise<string> {
  const { db, cfg, resolvePat } = deps;
  const host = row.host;
  const ownerRepo = row.repo;
  const pr = row.pr_number;
  const headRef = row.head_ref;
  const baseRef = row.base_ref;
  const taskPrompt = row.task_prompt ?? '';

  const diff = await loadDiff({ cwd: prepared.path, baseRef, headRef });

  // 1. Triage Copilot threads.
  const copilotPrompt = render(TRIAGE_COPILOT_TEMPLATE, {
    task_prompt: taskPrompt, repo: ownerRepo, pr_number: String(pr),
    threads: renderThreadsBlock(open), diff: diff.patch,
  });
  const copResult = await runClaudeStep(deps, copilotPrompt, prepared.path, cfg.triageModel);
  let copilotVerdicts = copResult.outcome === 'success' ? safeParse(copResult.finalText, 'thread_id', COPILOT_VERDICTS) : [];

  // 2. Triage failing checks (only if any).
  let ciVerdicts: Verdict[] = [];
  if (failing.length) {
    const ciPrompt = render(TRIAGE_CI_TEMPLATE, {
      repo: ownerRepo, pr_number: String(pr), checks: renderChecksBlock(failing), diff: diff.patch,
    });
    const ciResult = await runClaudeStep(deps, ciPrompt, prepared.path, cfg.triageModel);
    if (ciResult.outcome === 'success') ciVerdicts = safeParse(ciResult.finalText, 'check', CI_VERDICTS);
  }

  // 3. Partition.
  let copilotFixes = copilotVerdicts.filter((v) => v.verdict === 'fix');
  const replies = copilotVerdicts.filter((v) => v.verdict === 'reply');
  const acks = copilotVerdicts.filter((v) => v.verdict === 'ack');
  let escalations = copilotVerdicts.filter((v) => v.verdict === 'escalate');
  let ciFixes = ciVerdicts.filter((v) => v.verdict === 'fix' || v.verdict === 'autofix');
  escalations = escalations.concat(ciVerdicts.filter((v) => v.verdict === 'escalate'));

  const threadsById = new Map<string, gh.ReviewThread>();
  for (const t of open) if (t.id) threadsById.set(t.id, t);

  // 4. Apply fixes via claude, then commit + push. Operator comments are always handed to the fixer
  //    (they're free-text guidance, not triaged thread verdicts).
  let commitSha: string | null = null;
  if (copilotFixes.length || ciFixes.length || operator.length) {
    const fixPrompt = composeFixPrompt({ taskPrompt, prNumber: pr, copilotFixes, ciFixes, threadsById, operator });
    const fixResult = await runClaudeStep(deps, fixPrompt, prepared.path, cfg.fixModel);
    if (fixResult.outcome === 'success') {
      commitSha = await commitAll(prepared.path, commitMessage({ prNumber: pr, iteration: row.iteration + 1, copilotFixes, ciFixes }));
      if (commitSha === null) {
        // claude often commits itself in -p mode; if the tip advanced, a fix DID land — push it.
        const headNow = await currentHeadSha(prepared.path);
        if (headNow && headNow !== prepared.headSha) commitSha = headNow;
      }
      if (commitSha) {
        await pushBranch(db, resolvePat, { prepared, branch: headRef });
      } else {
        // claude edited nothing — don't resolve threads on an empty promise; escalate instead.
        console.warn(`[sage] fix run made no edits for ${ownerRepo}#${pr}`);
        escalations = escalations.concat([...copilotFixes, ...ciFixes].map((v) => ({ ...v, verdict: 'escalate' })));
        copilotFixes = [];
        ciFixes = [];
      }
    } else {
      console.warn(`[sage] fix run did not complete for ${ownerRepo}#${pr} (outcome=${fixResult.outcome})`);
      escalations = escalations.concat([...copilotFixes, ...ciFixes].map((v) => ({ ...v, verdict: 'escalate' })));
      copilotFixes = [];
      ciFixes = [];
    }
  }

  // 5. Resolve / reply on threads.
  const link = commitSha ? `Addressed in ${commitSha.slice(0, 10)}.` : 'Addressed.';
  for (const v of copilotFixes) await replyThenResolve(deps, host, ownerRepo, v.ref, `${link} ${v.reason}`.trim());
  for (const v of replies) await replyThenResolve(deps, host, ownerRepo, v.ref, v.reason || 'Sage reviewed this and is keeping the current approach.');
  for (const v of acks) await resolveSafe(deps, host, ownerRepo, v.ref);
  // escalate threads are deliberately left open (human-visible).

  // 6. Audit rows.
  const items: FindingItem[] = [
    ...verdictsToItems(copilotFixes, 'copilot'),
    ...verdictsToItems(ciFixes, 'ci'),
    ...verdictsToItems(replies, 'copilot'),
    ...verdictsToItems(acks, 'copilot'),
    ...verdictsToItems(escalations, 'escalation'),
  ];
  await insertIterationFindings(db, { host, repo: ownerRepo, headRef, baseRef, prNumber: pr, commitSha, items });

  // 7. Progress comment + advance the cursor.
  await commentSafe(deps, host, ownerRepo, pr, iterationComment({
    iteration: row.iteration + 1, commitSha, copilotFixes, ciFixes, replies, acks, escalations, operatorCount: operator.length,
  }));
  const nextIter = row.iteration + 1;
  if (escalations.length) {
    await track.advance(db, { rowId: row.id, status: 'escalated', iteration: nextIter, lastCommitSha: commitSha, escalationsDelta: escalations.length });
    const reason = formatItemsEscalation(ownerRepo, pr, escalations);
    await escalateSafe(deps, row, reason, escalations.map((v) => v.ref).filter(Boolean));
    return 'escalated';
  }
  await track.advance(db, { rowId: row.id, status: 'open', iteration: nextIter, lastCommitSha: commitSha });
  return 'iterated';
}

function safeParse(text: string, refKey: 'thread_id' | 'check', allowed: Set<string>): Verdict[] {
  try {
    return parseVerdicts(text, refKey, allowed);
  } catch (e) {
    console.warn(`[sage] triage parse failed (${refKey}): ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ── self-review fallback path (Copilot never engaged) — 005 §7 step 6 ───────────

// Fold failing CI checks into the self-review's blocking set as error-severity concerns: a clean
// diff on a CI-red PR must NOT be marked done (#62). The fixer has the branch checked out, so it can
// reproduce and fix.
function ciConcernsFromChecks(failing: gh.CheckRow[]): Concern[] {
  return failing.map((c) => {
    const name = String(c.name ?? 'check');
    let msg = `CI check '${name}' is failing — reproduce in the workspace and fix it`;
    if (c.link) msg += ` (${c.link})`;
    return { severity: 'error' as const, kind: 'ci', file: null, line: null, message: msg, suggestedFix: null };
  });
}

function concernLoc(c: Concern): string {
  if (c.file) return `\`${c.file}\`${c.line ? `:${c.line}` : ''}`;
  if (c.kind === 'ci') return '**[CI]**';
  return '(PR-level)';
}

function selfreviewCleanComment(model: string, noteCount: number): string {
  const notes = noteCount ? ` (${noteCount} non-blocking note(s) raised)` : '';
  return `🤖 **Sage self-review** (\`${model}\`): no Copilot review was available, so an independent cheap-model review stood in and found nothing blocking${notes}. CI is green (or absent). Ready for human review / merge — sage does not auto-merge.`;
}

function composeSelfreviewFixPrompt(opts: { taskPrompt: string; prNumber: number; model: string; concerns: Concern[] }): string {
  const lines = [
    `You are sage's PR-iteration fixer. An independent self-review (model \`${opts.model}\`) flagged the items below on this PR. Apply ONLY the fixes needed to address them in the current working tree.`,
    '',
    'Hard rules:',
    '- Do NOT commit, push, amend, or create branches — sage does that after you return. Just edit the files.',
    '- Never use `--no-verify`, never delete or xfail a test, never disable a hook to make something pass.',
    '- Keep the changes minimal and scoped to the items below.',
    "- Follow the repo's CLAUDE.md \"Common failure modes\": for any apps/web change run `cd apps/web && pnpm run typecheck`; never rewrite pnpm-lock.yaml unless you changed deps; never put backslashes in file paths (escaped Next route segments); Postgres has no `ADD CONSTRAINT IF NOT EXISTS`.",
    '',
    `This is PR #${opts.prNumber}. What the PR set out to do:`,
    opts.taskPrompt || '(no task prompt recorded)',
    '',
    '## Self-review findings to address',
  ];
  for (const c of opts.concerns) {
    const loc = c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : '(PR-level)';
    const kind = c.kind ? ` [${c.kind}]` : '';
    lines.push(`- (${c.severity})${kind} ${loc}: ${c.message}`);
    if (c.suggestedFix) lines.push(`  → suggested: ${c.suggestedFix}`);
  }
  lines.push('', 'When done, stop. Do not summarise — sage reads the diff, not your final message.');
  return lines.join('\n');
}

function selfreviewBlockComment(model: string, concerns: Concern[]): string {
  const lines = [
    `🤖 **Sage self-review** (\`${model}\`): no Copilot review was available, so an independent cheap-model review stood in and flagged ${concerns.length} blocking item(s). Pausing for a human — sage does not auto-fix on a self-review-only verdict.`,
    '',
  ];
  for (const c of concerns) {
    const loc = c.file ? `\`${c.file}\`${c.line ? `:${c.line}` : ''}` : '(PR-level)';
    const kind = c.kind ? ` [${c.kind}]` : '';
    lines.push(`- **${c.severity}**${kind} ${loc}: ${c.message}`);
    if (c.suggestedFix) lines.push(`  - suggested: ${c.suggestedFix}`);
  }
  return lines.join('\n');
}

function selfreviewFixComment(model: string, concerns: Concern[], commitSha: string | null, iteration: number): string {
  const sha = commitSha ? ` in \`${commitSha.slice(0, 10)}\`` : '';
  const lines = [
    `🤖 **Sage self-review fix** (iteration ${iteration}, \`${model}\`): addressed ${concerns.length} item(s)${sha} from the independent self-review (no Copilot available):`,
    '',
  ];
  for (const c of concerns) lines.push(`- ${concernLoc(c)} ${c.message}`);
  lines.push('', 'Re-reviewing on the next pass.');
  return lines.join('\n');
}

function concernsToFindingItems(concerns: Concern[], verdict: 'fix' | 'escalate'): FindingItem[] {
  return concerns.map((c) => ({ verdict, kind: 'selfreview', file: c.file, line: c.line, message: c.message, suggestedFix: c.suggestedFix }));
}

// Settle a Copilot-less PR via the OpenRouter self-review. Read-only: fetches the PR diff over the
// API (no workspace lease) and asks the cheap model for a verdict. approve → terminate clean;
// request_changes → fix the blocking findings (or escalate if the fixer can't); error → retry next tick.
async function selfReviewPath(deps: IterationDeps, row: CursorRow, failing: gh.CheckRow[], sig: string): Promise<string> {
  const { db, cfg, resolvePat, selfreview } = deps;
  if (!selfreview) return 'not_settled';
  const host = row.host;
  const ownerRepo = row.repo;
  const pr = row.pr_number;

  let diffText: string;
  try {
    diffText = await gh.prDiff(resolvePat, { host, ownerRepo, number: pr });
  } catch (e) {
    console.error(`[sage] self-review diff fetch failed for ${ownerRepo}#${pr}: ${e instanceof Error ? e.message : String(e)}`);
    return 'not_settled';
  }

  const result = await runSelfReview(selfreview, { taskPrompt: row.task_prompt ?? '', repo: ownerRepo, prNumber: pr, diff: diffText });
  if (result.verdict === 'error') return 'not_settled'; // flaky cheap model must not retire the PR

  const nextIter = row.iteration + 1;
  // #62: a clean diff is NOT "done" while CI is red — fold failing checks into the blocking set.
  const blocking = blockingConcerns(result.concerns).concat(ciConcernsFromChecks(failing));

  if (!blocking.length) {
    await commentSafe(deps, host, ownerRepo, pr, selfreviewCleanComment(result.model, result.concerns.length));
    await track.advance(db, { rowId: row.id, status: 'done', iteration: nextIter });
    return 'done';
  }

  // #64: track no-progress, park `waiting` at the cap instead of churning.
  const unresolved = blocking.length;
  const noProgress = nextNoProgress(row, sig, unresolved);
  await track.updateProgress(db, { rowId: row.id, noProgressPasses: noProgress, lastUnresolved: unresolved, lastInputSig: sig });
  if (noProgress >= cfg.maxIterations) {
    const reason = `made no progress for ${noProgress} consecutive pass(es) with ${blocking.length} unresolved self-review/CI item(s)`;
    return stallToWaiting(deps, row, sig, reason, []);
  }

  if (!(await track.tryClaimIterating(db, row.id, cfg.concurrency))) return 'no_slot';
  let prepared: PreparedWorkspace | null = null;
  try {
    prepared = await preparePrWorkspace(db, resolvePat, {
      host, owner: ownerRepo.split('/')[0]!, repo: ownerRepo.split('/')[1]!,
      stack: deriveStack(row.cwd, row.stack), nodeId: cfg.nodeId, headRef: row.head_ref,
    });
    if (prepared === null) {
      await track.advance(db, { rowId: row.id, status: 'open' });
      return 'lease_busy';
    }
    return await selfReviewFix(deps, row, prepared, result.model, blocking);
  } catch (e) {
    console.error(`[sage] self-review fix failed for ${ownerRepo}#${pr}: ${e instanceof Error ? e.message : String(e)}`);
    await track.advance(db, { rowId: row.id, status: 'open' });
    return 'error';
  } finally {
    if (prepared !== null) {
      try {
        await releaseWorkspace(db, prepared);
      } catch (e) {
        console.warn(`[sage] lease release failed for ${ownerRepo}#${pr}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

// Apply the self-review's blocking findings via the fixer, commit, push. Clean fix → advance open
// (re-reviewed next tick). Fixer failure / no edits → escalate (never resolve on an empty promise).
async function selfReviewFix(deps: IterationDeps, row: CursorRow, prepared: PreparedWorkspace, model: string, blocking: Concern[]): Promise<string> {
  const { db, cfg, resolvePat } = deps;
  const host = row.host;
  const ownerRepo = row.repo;
  const pr = row.pr_number;
  const headRef = row.head_ref;
  const nextIter = row.iteration + 1;

  const escalate = async (): Promise<string> => {
    await commentSafe(deps, host, ownerRepo, pr, selfreviewBlockComment(model, blocking));
    await insertIterationFindings(db, { host, repo: ownerRepo, headRef, baseRef: row.base_ref, prNumber: pr, commitSha: null, items: concernsToFindingItems(blocking, 'escalate') });
    await track.advance(db, { rowId: row.id, status: 'escalated', iteration: nextIter, escalationsDelta: blocking.length });
    const reason = `${blocking.length} item(s): ${blocking.map((c) => `${c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : '(PR-level)'} ${c.message}`).join('; ')}`;
    await escalateSafe(deps, row, reason, blocking.map((c) => (c.file ? (c.line ? `${c.file}:${c.line}` : c.file) : '(PR-level)')));
    return 'escalated';
  };

  const fixPrompt = composeSelfreviewFixPrompt({ taskPrompt: row.task_prompt ?? '', prNumber: pr, model, concerns: blocking });
  const fixResult = await runClaudeStep(deps, fixPrompt, prepared.path, cfg.fixModel);
  if (fixResult.outcome !== 'success') {
    console.warn(`[sage] self-review fixer did not complete for ${ownerRepo}#${pr} (outcome=${fixResult.outcome})`);
    return escalate();
  }

  let commitSha = await commitAll(prepared.path, `fix: address self-review on PR #${pr} (iteration ${nextIter}, ${blocking.length} item(s))`);
  if (commitSha === null) {
    const headNow = await currentHeadSha(prepared.path);
    if (headNow && headNow !== prepared.headSha) commitSha = headNow;
  }
  if (!commitSha) {
    console.warn(`[sage] self-review fixer made no edits for ${ownerRepo}#${pr}`);
    return escalate();
  }

  await pushBranch(db, resolvePat, { prepared, branch: headRef });
  await insertIterationFindings(db, { host, repo: ownerRepo, headRef, baseRef: row.base_ref, prNumber: pr, commitSha, items: concernsToFindingItems(blocking, 'fix') });
  await commentSafe(deps, host, ownerRepo, pr, selfreviewFixComment(model, blocking, commitSha, nextIter));
  await track.advance(db, { rowId: row.id, status: 'open', iteration: nextIter, lastCommitSha: commitSha });
  return 'iterated';
}

// ── thin error-isolating wrappers (a comment/resolve failure must not abort a pushed iteration) ──

async function replyThenResolve(deps: IterationDeps, host: string, ownerRepo: string, threadId: string, body: string): Promise<void> {
  try {
    await gh.replyToThread(deps.resolvePat, { host, ownerRepo, threadId, body });
    await gh.resolveThread(deps.resolvePat, { host, ownerRepo, threadId });
  } catch (e) {
    console.warn(`[sage] reply/resolve failed for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function resolveSafe(deps: IterationDeps, host: string, ownerRepo: string, threadId: string): Promise<void> {
  try {
    await gh.resolveThread(deps.resolvePat, { host, ownerRepo, threadId });
  } catch (e) {
    console.warn(`[sage] resolve failed for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function commentSafe(deps: IterationDeps, host: string, ownerRepo: string, number: number, body: string): Promise<void> {
  try {
    await gh.prComment(deps.resolvePat, { host, ownerRepo, number, body });
  } catch (e) {
    console.warn(`[sage] pr_comment failed for ${ownerRepo}#${number}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function escalateSafe(deps: IterationDeps, row: CursorRow, reason: string, threadIds: string[], reasonClass?: string): Promise<void> {
  if (!deps.escalate) return;
  try {
    await deps.escalate({
      userId: row.user_id, repo: row.repo, prNumber: row.pr_number, headRef: row.head_ref,
      nodeId: row.node_id, reason, prUrl: `https://${row.host}/${row.repo}/pull/${row.pr_number}`, threadIds, reasonClass,
    });
  } catch (e) {
    console.warn(`[sage] escalate inbox write failed for ${row.repo}#${row.pr_number}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
