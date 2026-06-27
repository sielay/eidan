// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic claim→PR pipeline (eidan-sage#15) — port of pipeline.py. The harness owns every git
// and PR mechanic; the LLM (`claude`) only writes code. This replaces the v0 single-turn stub and
// the older spawn-turn conductor (a weaker second agentic loop that stalled on git/PR sequencing).
//
// Flow — each step posts a milestone to the operator's sage channel:
//   1. lease + a fresh feature branch off base (initial-work mode).
//   2. run `claude` in the workspace — the ONLY LLM step; it edits files, never touches git.
//   3. commit + push (harness-owned).
//   4. open the PR + request Copilot review + seed the iteration-loop cursor (no pre-PR critic gate:
//      a PR exists to BE reviewed; review happens on the PR, Copilot first).
//   5. release the lease (always, even on failure).
import { runClaude } from './claude.js';
import {
  preparePrWorkspace, commitAll, pushBranch, releaseWorkspace, currentHeadSha,
  type PatResolver, type PreparedWorkspace,
} from './git.js';
import { prCreate, requestCopilotReview } from './gh.js';
import { seedCursor } from './tracking.js';
import type { Db } from './db.js';
import type { SageConfig } from './config.js';

export type Notify = (text: string, severity?: string) => Promise<void>;

export interface PipelineResult {
  status: 'done' | 'failed' | 'blocked' | 'requeue' | 'skipped';
  prUrl?: string;
  error?: string;
}

// `owner/repo` or `host:owner/repo` → { host, owner, repo }.
export function parseRepo(repo: string): { host: string; owner: string; repo: string } {
  let host = 'github.com';
  let spec = repo.trim();
  if (spec.includes(':') && !spec.includes('://')) {
    const [h, rest] = spec.split(/:(.+)/);
    host = h!;
    spec = rest!;
  }
  const [owner, name] = spec.split('/');
  return { host, owner: owner!, repo: name! };
}

function branchName(stack: string, ref: string): string {
  return `sage/${stack}-${ref}-${crypto.randomUUID().slice(0, 8)}`;
}

const OPEN_QUESTIONS_RE = /#+\s*open questions\s*\n([\s\S]*)$/i;

export function extractOpenQuestions(finalText: string): string {
  if (!finalText) return '';
  const m = OPEN_QUESTIONS_RE.exec(finalText);
  if (!m) return '';
  const body = m[1]!.trim();
  if (['none', 'n/a', ''].includes(body.toLowerCase().replace(/[. ]/g, ''))) return '';
  return body;
}

function codingPrompt(owner: string, repo: string, title: string, goal: string): string {
  return (
    'You are sage, an autonomous coding agent. You are ALREADY in a clean git workspace checked out ' +
    'on a fresh feature branch for this task. Make ONLY the code changes needed to accomplish the ' +
    'task below.\n\n' +
    'Do NOT run `git commit`, `git push`, or open a pull request — the harness handles every git and ' +
    'PR mechanic for you. Your job is solely to edit the files in this workspace so the task is done. ' +
    'Keep the change minimal and focused.\n\n' +
    `Repository: ${owner}/${repo}\n` +
    `Task: ${title}\n\n` +
    `${goal}\n\n` +
    '## Decision-making: pragmatic defaults\n\n' +
    'When the task describes a design decision (polling vs events, materialized views, OCR language, schema variants, UI options, etc.):\n' +
    '1. Make the pragmatic default choice that follows existing codebase patterns\n' +
    '2. Document your choice inline (code comment or git commit message)\n' +
    '3. ONLY escalate genuine blockers: missing credentials, external API down, permission denied, contradictory spec, or deployment setup changes needed\n' +
    '4. DO NOT ask design trade-off questions in the "Open questions" section\n\n' +
    'Examples:\n' +
    '- Which OCR language? → Use \'eng\', note it\'s configurable\n' +
    '- Polling vs events? → Use polling (matches schedule trigger pattern); add TODO for later performance refactoring if needed\n' +
    '- Materialized views? → Use on-the-fly queries; add TODO if performance becomes a problem\n' +
    '- Node ID or metadata? → Use what exists; add fallback if missing\n' +
    '- Multiple valid schema designs? → Pick the one requiring least future refactoring; document the choice\n\n' +
    'When you are done, END your reply with a section headed exactly `## Open questions` — list ' +
    'anything the operator should decide or confirm. A few bullets at most. Use this ONLY for genuine blockers. ' +
    'If there are genuinely none, write `None.` on the line under the heading.\n'
  );
}

function prBody(title: string, goal: string, jobId: string, openQuestions: string): string {
  let excerpt = (goal || '').trim();
  if (excerpt.length > 600) excerpt = `${excerpt.slice(0, 600).trimEnd()} …`;
  const parts = ['### What & why', `**${title}**`];
  if (excerpt && excerpt !== title) {
    parts.push(excerpt.split('\n').map((ln) => (ln ? `> ${ln}` : '>')).join('\n'));
  }
  const forYou = ['### For you', 'Review the diff and merge if it looks right.'];
  if (openQuestions) forYou.push(`\n**Open questions sage flagged — please confirm:**\n${openQuestions}`);
  parts.push(forYou.join('\n'));
  parts.push('_Coded autonomously by sage. Review happens on this PR — Copilot first, with sage\'s own self-review as a fallback._');
  parts.push(`_Delegated via job \`${jobId}\`._`);
  return parts.join('\n\n');
}

export interface PipelineDeps {
  db: Db;
  cfg: SageConfig;
  resolvePat: PatResolver;
  notify: Notify;
}

export interface PipelineJob {
  jobId: string;
  host: string;
  owner: string;
  repo: string;
  stack: string;
  title: string;
  goal: string;
  userId: string | null;
  // Per-job model override (eidan core job targeting); null = use the node's configured default.
  model?: string | null;
}

// Drive one claimed `code` job: workspace → coded change → PR. Never throws — every failure is
// caught, posted, and the lease released in a finally.
export async function runInitialPipeline(deps: PipelineDeps, job: PipelineJob): Promise<PipelineResult> {
  const { db, cfg, resolvePat, notify } = deps;
  const ownerRepo = `${job.owner}/${job.repo}`;
  const short = job.jobId.slice(0, 8);
  const jobRef = `${ownerRepo} (job ${short})`;

  if (cfg.claudeBinPath === null) {
    await notify(`⚠️ ${jobRef}: no \`claude\` on this node — cannot code the change`, 'warn');
    return { status: 'skipped', error: 'no claude binary' };
  }

  const base = cfg.defaultBase;
  const branch = branchName(job.stack, short);
  await notify(`🛠️ Sage picked up ${jobRef} — “${job.title}”. Coding on \`${branch}\` (base \`${base}\`).`);

  let prepared: PreparedWorkspace | null = null;
  try {
    // 1. Lease + fresh branch off base.
    prepared = await preparePrWorkspace(db, resolvePat, {
      host: job.host, owner: job.owner, repo: job.repo, stack: job.stack,
      nodeId: cfg.nodeId, headRef: branch, baseRef: base,
    });
    if (prepared === null) {
      await notify(`⏳ ${jobRef}: workspace for stack \`${job.stack}\` is busy (a peer holds the lease) — re-queuing`, 'warn');
      return { status: 'requeue', error: 'workspace lease busy' };
    }

    // 2. The ONLY LLM step: code the change. A per-job model override (job targeting) wins over
    //    the node's configured default; provider is N/A here (sage shells the local `claude` CLI).
    const codingModel = job.model ?? cfg.fixModel;
    await notify(`🤖 ${jobRef}: coding the change…${job.model ? ` (model \`${job.model}\`)` : ''}`);
    const coding = await runClaude({
      binPath: cfg.claudeBinPath,
      prompt: codingPrompt(job.owner, job.repo, job.title, job.goal),
      cwd: prepared.path,
      model: codingModel,
      oauthToken: cfg.oauthToken,
      system: cfg.ponytailSystem,
      pluginDir: cfg.ponytailDir ?? undefined,
      ponytailMode: cfg.ponytailMode,
      inactivityTimeoutMs: cfg.inactivityTimeoutMs,
      hardCapMs: cfg.hardCapMs,
      maxOutputTail: cfg.maxOutputTail,
    });
    if (coding.outcome !== 'success') {
      await notify(`❌ ${jobRef}: coding run did not finish cleanly (\`${coding.outcome}\`) — no PR opened`, 'warn');
      return { status: 'failed', error: `coding run ${coding.outcome}` };
    }

    // 3. Commit + push.
    let sha = await commitAll(prepared.path, `sage: ${job.title}\n\nDelegated via job ${job.jobId}.`);
    if (sha === null) {
      // The claude CLI sometimes commits on its own despite being told not to — check whether the
      // tip advanced even though our commit was a no-op.
      const head = await currentHeadSha(prepared.path);
      if (head && head !== prepared.headSha) {
        sha = head;
      } else {
        await notify(`ℹ️ ${jobRef}: coding run made no file changes — nothing to open a PR for`, 'warn');
        return { status: 'failed', error: 'coding run made no changes' };
      }
    }
    await pushWithLease(db, resolvePat, prepared, branch);
    await notify(`📤 ${jobRef}: pushed \`${branch}\` (${sha.slice(0, 8)}) — opening the PR`);

    // 4. Open the PR + request Copilot + seed the loop cursor.
    let opened;
    try {
      opened = await prCreate(resolvePat, {
        host: job.host,
        ownerRepo,
        head: branch,
        base,
        title: job.title,
        body: prBody(job.title, job.goal, job.jobId, extractOpenQuestions(coding.finalText)),
      });
    } catch (exc) {
      const code = exc instanceof Error && 'code' in exc ? (exc as { code: string }).code : String(exc);
      await notify(`❌ ${jobRef}: opening the PR failed (${code}); branch \`${branch}\` is pushed`, 'warn');
      return { status: 'failed', error: `open PR failed: ${code}` };
    }

    await seedCursor(db, {
      host: job.host, repo: ownerRepo, prNumber: opened.number, headRef: branch, baseRef: base,
      stack: job.stack, cwd: prepared.path, taskPrompt: codingPrompt(job.owner, job.repo, job.title, job.goal),
      nodeId: cfg.nodeId, lastCommitSha: sha, userId: job.userId,
    });

    // Best-effort: ask Copilot to review. Failure (not enabled / quota) just falls through to the
    // loop's self-review fallback; never breaks the open flow.
    if (opened.number > 0) {
      try {
        const cop = await requestCopilotReview(resolvePat, { host: job.host, ownerRepo, number: opened.number });
        if (!cop.requested && cop.detail) console.warn(`[sage] Copilot review not requested for ${ownerRepo}#${opened.number}: ${cop.detail}`);
      } catch (e) {
        console.warn(`[sage] requestCopilotReview errored: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await notify(`✅ ${jobRef}: PR open on \`${branch}\` — handed to the Copilot/CI iteration loop`);
    return { status: 'done', prUrl: opened.url };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    console.error(`[sage] pipeline crashed for ${jobRef}: ${msg}`);
    await notify(`❌ ${jobRef}: sage pipeline error — ${msg}`, 'warn');
    return { status: 'failed', error: msg };
  } finally {
    if (prepared !== null) {
      try {
        await releaseWorkspace(db, prepared);
      } catch (e) {
        console.warn(`[sage] lease release failed for ${jobRef}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

// Push a freshly-coded branch; a new uuid-suffixed branch fast-forwards, but if the remote moved we
// force-with-lease (sage exclusively owns sage/* branches).
async function pushWithLease(db: Db, resolvePat: PatResolver, prepared: PreparedWorkspace, branch: string): Promise<void> {
  try {
    await pushBranch(db, resolvePat, { prepared, branch });
  } catch (exc) {
    if (exc instanceof Error && 'code' in exc && (exc as { code: string }).code === 'git.upstream_diverged') {
      await pushBranch(db, resolvePat, { prepared, branch, force: true });
      return;
    }
    throw exc;
  }
}
