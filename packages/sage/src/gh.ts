// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin `gh` CLI wrapper — port of the eidan_gh tool/api surface the pipeline + loop drive directly
// (outside any agentic turn). The PAT rides in GH_TOKEN on the child only, never argv. Brick 1
// needs open-PR + request-Copilot + comment; the review/checks/threads read+resolve ops the
// iteration loop uses land alongside it so the loop brick has its substrate.
import { spawn } from 'node:child_process';
import type { PatResolver } from './git.js';

export class GhError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GhError';
  }
}

function ghBin(): string { return process.env['EIDAN_GH_BIN']?.trim() || 'gh'; }

export interface GhResult { stdout: string; stderr: string; exitCode: number }

async function gh(args: string[], opts: { host: string; token: string; timeoutMs?: number }): Promise<GhResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
    if (k in process.env) env[k] = process.env[k];
  }
  env['GH_TOKEN'] = opts.token;
  env['GH_PROMPT_DISABLED'] = '1';
  if (opts.host && opts.host !== 'github.com') env['GH_HOST'] = opts.host;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise<GhResult>((resolve, reject) => {
    const child = spawn(ghBin(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new GhError('gh.timeout', `gh ${args[0]} timed out`)); }, timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new GhError('gh.binary_missing', `gh not found at ${ghBin()}`) : e);
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
  });
}

function requireWrite(resolvePat: PatResolver, host: string, ownerRepo: string): string {
  const w = resolvePat({ host, ownerRepo, scope: 'write' });
  if (w) return w;
  if (resolvePat({ host, ownerRepo, scope: 'read' })) throw new GhError('pat.write_required', `write PAT required for ${host}:${ownerRepo}`);
  throw new GhError('pat.unavailable', `no PAT matches ${host}:${ownerRepo} scope=write`);
}
function requireRead(resolvePat: PatResolver, host: string, ownerRepo: string): string {
  const r = resolvePat({ host, ownerRepo, scope: 'read' });
  if (!r) throw new GhError('pat.unavailable', `no PAT matches ${host}:${ownerRepo} scope=read`);
  return r;
}

export interface OpenedPr { url: string; number: number }

// Open a PR. The branch must already be pushed. Returns the URL + number, parsed from `gh pr create`
// (which prints the URL) backed by a `gh pr view` for the number.
export async function prCreate(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; head: string; base: string; title: string; body: string },
): Promise<OpenedPr> {
  const token = requireWrite(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(
    ['pr', 'create', '--repo', opts.ownerRepo, '--head', opts.head, '--base', opts.base, '--title', opts.title, '--body', opts.body],
    { host: opts.host, token },
  );
  if (r.exitCode !== 0) throw new GhError(`gh.exit_${r.exitCode}`, `pr create failed: ${r.stderr.slice(0, 400)}`);
  const url = (r.stdout.trim().split(/\s+/).find((t) => t.startsWith('http')) ?? r.stdout.trim()) || '';
  const view = await gh(['pr', 'view', opts.head, '--repo', opts.ownerRepo, '--json', 'number,url'], { host: opts.host, token });
  let number = 0;
  if (view.exitCode === 0) {
    try {
      const data = JSON.parse(view.stdout) as { number?: number; url?: string };
      number = data.number ?? 0;
    } catch { /* best-effort */ }
  }
  return { url, number };
}

// Request a GitHub Copilot review (Phase B step 5). Never throws on a gh failure — Copilot not
// enabled / quota exhausted / already pending all come back as { requested: false, detail }.
export async function requestCopilotReview(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; number: number },
): Promise<{ requested: boolean; detail: string }> {
  const token = requireWrite(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(['pr', 'edit', String(opts.number), '--repo', opts.ownerRepo, '--add-reviewer', '@copilot'], { host: opts.host, token });
  if (r.exitCode === 0) return { requested: true, detail: '' };
  return { requested: false, detail: (r.stderr || '').trim() };
}

// Post a top-level PR comment (per-iteration summary, terminal handoff).
export async function prComment(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; number: number; body: string },
): Promise<void> {
  const token = requireWrite(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(['pr', 'comment', String(opts.number), '--repo', opts.ownerRepo, '--body', opts.body], { host: opts.host, token });
  if (r.exitCode !== 0) throw new GhError(`gh.exit_${r.exitCode}`, `pr comment failed: ${r.stderr.slice(0, 300)}`);
}

// Return a PR's unified diff (read scope) — used by the self-review fallback without a checkout.
export async function prDiff(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; number: number },
): Promise<string> {
  const token = requireRead(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(['pr', 'diff', String(opts.number), '--repo', opts.ownerRepo], { host: opts.host, token });
  if (r.exitCode !== 0) throw new GhError(`gh.exit_${r.exitCode}`, `pr diff failed: ${r.stderr.slice(0, 300)}`);
  return r.stdout || '';
}

// ── The PR-iteration read/resolve surface (005 §5.4) ────────────────────────────

export interface ReviewsPayload { reviews: unknown[]; reviewDecision: string | null; requested: unknown[] }

// reviews + reviewDecision + still-pending reviewRequests. Sage reads `reviews` for Copilot's
// submitted review and `requested` to tell "Copilot mid-review" from "Copilot never engaged".
export async function reviews(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; number: number },
): Promise<ReviewsPayload> {
  const token = requireRead(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(
    ['pr', 'view', String(opts.number), '--repo', opts.ownerRepo, '--json', 'reviews,reviewDecision,reviewRequests'],
    { host: opts.host, token },
  );
  if (r.exitCode !== 0) throw new GhError(`gh.exit_${r.exitCode}`, `pr view failed: ${r.stderr.slice(0, 300)}`);
  const data = JSON.parse(r.stdout || '{}') as Record<string, unknown>;
  return {
    reviews: Array.isArray(data['reviews']) ? (data['reviews'] as unknown[]) : [],
    reviewDecision: typeof data['reviewDecision'] === 'string' ? (data['reviewDecision'] as string) : null,
    requested: Array.isArray(data['reviewRequests']) ? (data['reviewRequests'] as unknown[]) : [],
  };
}

export interface PrComment { author: string | null; body: string; createdAt: string; isBot: boolean }

// The PR's conversation (issue) comments — NOT review threads. Sage reads these so OPERATOR feedback
// left as a plain PR comment drives iteration too (not only Copilot/human review threads).
export async function prComments(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; number: number },
): Promise<PrComment[]> {
  const token = requireRead(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(
    ['pr', 'view', String(opts.number), '--repo', opts.ownerRepo, '--json', 'comments'],
    { host: opts.host, token },
  );
  if (r.exitCode !== 0) throw new GhError(`gh.exit_${r.exitCode}`, `pr view (comments) failed: ${r.stderr.slice(0, 300)}`);
  const data = JSON.parse(r.stdout || '{}') as Record<string, unknown>;
  const raw = Array.isArray(data['comments']) ? (data['comments'] as Record<string, unknown>[]) : [];
  return raw.map((c) => {
    const login = ((c['author'] as Record<string, unknown>)?.['login'] as string) ?? null;
    return {
      author: login,
      body: String(c['body'] ?? ''),
      createdAt: String(c['createdAt'] ?? ''),
      isBot: !!login && (/\[bot\]$/i.test(login) || /^copilot/i.test(login) || login.toLowerCase() === 'github-actions'),
    };
  });
}

export interface CheckRow { name?: string; state?: string; bucket?: string; link?: string; workflow?: string; startedAt?: string; completedAt?: string }
export interface ChecksPayload { allSettled: boolean; checks: CheckRow[] }

const IN_FLIGHT = new Set(['queued', 'in_progress', 'pending', 'waiting']);
function checksSettled(checks: CheckRow[]): boolean {
  return !checks.some((c) => c && typeof c === 'object' && IN_FLIGHT.has((c.state ?? '').toLowerCase()));
}

// PR checks rollup. A CI-less repo (`gh pr checks` exits non-zero with "no checks reported") is a
// settled, empty rollup — not an error — so the settle probe doesn't stall on a workflow-less repo.
export async function checks(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; number: number },
): Promise<ChecksPayload> {
  const token = requireRead(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(
    ['pr', 'checks', String(opts.number), '--repo', opts.ownerRepo, '--json', 'name,state,bucket,link,startedAt,completedAt,workflow'],
    { host: opts.host, token },
  );
  if (r.exitCode !== 0 && (r.stderr || '').toLowerCase().includes('no checks reported')) {
    return { allSettled: true, checks: [] };
  }
  if (r.exitCode !== 0) throw new GhError(`gh.exit_${r.exitCode}`, `pr checks failed: ${r.stderr.slice(0, 300)}`);
  const rows = JSON.parse(r.stdout || '[]') as CheckRow[];
  return { allSettled: checksSettled(rows), checks: Array.isArray(rows) ? rows : [] };
}

export interface PrStatus { state: string; mergedAt: string | null }

// Open/closed/merged + merge timestamp. Used by the reconciler to mirror a PR's settle-state back
// onto its job (merged-by-anyone = review done, closed = abandoned).
export async function prStatus(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; number: number },
): Promise<PrStatus> {
  const token = requireRead(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(
    ['pr', 'view', String(opts.number), '--repo', opts.ownerRepo, '--json', 'state,mergedAt'],
    { host: opts.host, token },
  );
  if (r.exitCode !== 0) throw new GhError(`gh.exit_${r.exitCode}`, `pr view (status) failed: ${r.stderr.slice(0, 300)}`);
  const data = JSON.parse(r.stdout || '{}') as Record<string, unknown>;
  return {
    state: typeof data['state'] === 'string' ? (data['state'] as string) : 'UNKNOWN',
    mergedAt: typeof data['mergedAt'] === 'string' ? (data['mergedAt'] as string) : null,
  };
}

export interface ReviewThread { id: string | null; is_resolved: boolean; is_outdated: boolean; path: string | null; comments: Array<{ id: string | null; author: string | null; body: string | null }> }

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: $first) {
        nodes { id isResolved isOutdated path
          comments(first: 50) { nodes { id databaseId author { login } body createdAt } } }
      }
    }
  }
}`.trim();

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } }
}`.trim();

const REPLY_THREAD_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) { comment { id } }
}`.trim();

const THREAD_ID_RE = /^[A-Za-z0-9_=-]{1,200}$/;
function validateThreadId(id: string): string {
  if (!THREAD_ID_RE.test(id)) throw new GhError('gh.bad_thread_id', `invalid GraphQL thread id: ${id}`);
  return id;
}

function graphqlData(r: GhResult): unknown {
  if (r.exitCode !== 0) throw new GhError(`gh.exit_${r.exitCode}`, `graphql failed: ${r.stderr.slice(0, 300)}`);
  const parsed = JSON.parse(r.stdout || '{}') as { data?: unknown; errors?: unknown };
  if (parsed.errors) throw new GhError('gh.graphql_error', `graphql errors: ${JSON.stringify(parsed.errors).slice(0, 300)}`);
  return parsed.data;
}

// Flattened open+resolved review threads for a PR (005 §5.4.4 shape).
export async function reviewThreads(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; number: number; first?: number },
): Promise<ReviewThread[]> {
  const token = requireRead(resolvePat, opts.host, opts.ownerRepo);
  const [owner, name] = opts.ownerRepo.split('/');
  const r = await gh(
    ['api', 'graphql', '-f', `query=${REVIEW_THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${opts.number}`, '-F', `first=${opts.first ?? 100}`],
    { host: opts.host, token },
  );
  const data = graphqlData(r) as { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown[] } } } };
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const out: ReviewThread[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const n = node as Record<string, unknown>;
    const commentsNodes = ((n['comments'] as Record<string, unknown>)?.['nodes'] as unknown[]) ?? [];
    const comments = commentsNodes.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object').map((c) => ({
      id: (c['id'] as string) ?? null,
      author: ((c['author'] as Record<string, unknown>)?.['login'] as string) ?? null,
      body: (c['body'] as string) ?? null,
    }));
    out.push({
      id: (n['id'] as string) ?? null,
      is_resolved: Boolean(n['isResolved']),
      is_outdated: Boolean(n['isOutdated']),
      path: (n['path'] as string) ?? null,
      comments,
    });
  }
  return out;
}

export async function resolveThread(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; threadId: string },
): Promise<void> {
  const id = validateThreadId(opts.threadId);
  const token = requireWrite(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(['api', 'graphql', '-f', `query=${RESOLVE_THREAD_MUTATION}`, '-f', `threadId=${id}`], { host: opts.host, token });
  graphqlData(r);
}

export async function replyToThread(
  resolvePat: PatResolver,
  opts: { host: string; ownerRepo: string; threadId: string; body: string },
): Promise<void> {
  const id = validateThreadId(opts.threadId);
  const token = requireWrite(resolvePat, opts.host, opts.ownerRepo);
  const r = await gh(['api', 'graphql', '-f', `query=${REPLY_THREAD_MUTATION}`, '-f', `threadId=${id}`, '-f', `body=${opts.body}`], { host: opts.host, token });
  graphqlData(r);
}
