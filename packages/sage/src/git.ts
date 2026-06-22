// SPDX-License-Identifier: AGPL-3.0-or-later
// Git subprocess + per-(repo,stack) workspace lease + the prepare/commit/push/release API the
// pipeline drives. Collapses eidan_git.shell / workspace / lease / api into one module. Tokens are
// injected via http.extraHeader through GIT_CONFIG_* env (never argv or .git/config), matching
// actions/checkout. The lease is the authorisation surface: a node holds it before editing the
// shared clone, so a concurrent claim-turn and a sage iteration on the same stack can't interleave.
import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Db } from './db.js';

export class GitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GitError';
  }
}

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;
function checkSafe(label: string, value: string): void {
  if (!SAFE_NAME.test(value)) throw new GitError('git.bad_value', `${label} has unsafe chars: ${value}`);
}

function gitBin(): string { return process.env['EIDAN_GIT_BIN']?.trim() || 'git'; }
function workspaceRoot(): string {
  const raw = process.env['EIDAN_GIT_WORKSPACE_ROOT']?.trim() || '~/.eidan/workspaces';
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
}
function staleLease(): string { return process.env['EIDAN_GIT_STALE_LEASE']?.trim() || 'PT15M'; }

export interface GitResult { stdout: string; stderr: string; exitCode: number }

// Compose the child env: safe passthrough + anti-prompt guards + optional HTTPS auth header.
function buildEnv(token?: string): NodeJS.ProcessEnv {
  const keys = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keys) if (k in process.env) env[k] = process.env[k];
  env['GIT_TERMINAL_PROMPT'] = '0';
  // Portable no-op askpass so a credential miss dies fast instead of blocking on a TTY.
  env['GIT_ASKPASS'] = existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
  if (token) {
    const creds = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    env['GIT_CONFIG_COUNT'] = '1';
    env['GIT_CONFIG_KEY_0'] = 'http.extraHeader';
    env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${creds}`;
  }
  return env;
}

export async function git(
  args: string[],
  opts: { cwd?: string | undefined; token?: string | undefined; timeoutMs?: number | undefined } = {},
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn(gitBin(), args, {
      cwd: opts.cwd,
      env: buildEnv(opts.token),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new GitError('git.timeout', `git ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new GitError('git.binary_missing', `git not found at ${gitBin()}`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

// ── repos table + lease ───────────────────────────────────────────────────────

export async function getOrCreateRepo(db: Db, host: string, owner: string, name: string): Promise<string> {
  const r = await db.query(
    `insert into sage.repos (host, owner, name) values ($1,$2,$3)
       on conflict (host, owner, name) do update set updated_at = now()
       returning id`,
    [host, owner, name],
  );
  return r.rows[0]!.id as string;
}

// Acquire (or recover-if-stale) the lease for a checkout key. `lockKey` identifies the working tree
// being protected: in legacy shared-clone mode it is the `stack` (one checkout per repo+stack); in
// worktree mode it is the branch (headRef), so two same-repo jobs on different branches don't falsely
// contend. Stored in the repo_locks.stack column either way. Returns the new lease token, or null when
// a peer holds a fresh lease (skip-and-retry signal — NOT an error).
export async function acquireLease(
  db: Db,
  opts: { repoId: string; lockKey: string; nodeId: string },
): Promise<string | null> {
  const token = crypto.randomUUID();
  const r = await db.query(
    `insert into sage.repo_locks (repo_id, stack, node_id, lease_token)
       values ($1,$2,$3,$4)
       on conflict (repo_id, stack) do update
         set node_id = excluded.node_id, lease_token = excluded.lease_token,
             locked_at = now(), last_heartbeat_at = now()
         where sage.repo_locks.last_heartbeat_at < now() - ($5::text)::interval
       returning lease_token`,
    [opts.repoId, opts.lockKey, opts.nodeId, token, staleLease()],
  );
  if (!r.rowCount) return null; // conflict, peer lease still fresh
  return r.rows[0]!.lease_token as string;
}

// Confirm we still hold the lease (and refresh the heartbeat). Throws git.lease_lost if a peer
// force-claimed it mid-run.
export async function verifyLease(
  db: Db,
  opts: { repoId: string; lockKey: string; nodeId: string; leaseToken: string },
): Promise<void> {
  const r = await db.query(
    `update sage.repo_locks set last_heartbeat_at = now()
       where repo_id=$1 and stack=$2 and node_id=$3 and lease_token=$4 returning 1`,
    [opts.repoId, opts.lockKey, opts.nodeId, opts.leaseToken],
  );
  if (!r.rowCount) throw new GitError('git.lease_lost', `lease lost for ${opts.lockKey} — re-acquire`);
}

export async function releaseLease(
  db: Db,
  opts: { repoId: string; lockKey: string; nodeId: string; leaseToken: string },
): Promise<void> {
  await db.query(
    `delete from sage.repo_locks where repo_id=$1 and stack=$2 and node_id=$3 and lease_token=$4`,
    [opts.repoId, opts.lockKey, opts.nodeId, opts.leaseToken],
  );
}

// ── workspace ensure (clone-if-missing / fetch-if-present) ──────────────────────

// Per-job git worktrees: many jobs on ONE repo run concurrently in independent working trees that
// share a single clone's object store. Opt-in (default off keeps the proven shared-clone path), and
// only meaningful alongside EIDAN_JOBS_CONCURRENCY>1. See [[job_concurrency_and_worktrees]].
const useWorktrees = (): boolean => process.env['EIDAN_GIT_WORKTREES'] === '1';

// Legacy: one shared checkout per (repo, stack) — the whole job holds the lease on it.
function legacyWorkspacePath(host: string, owner: string, repo: string, stack: string): string {
  checkSafe('host', host); checkSafe('owner', owner); checkSafe('repo', repo); checkSafe('stack', stack);
  return join(workspaceRoot(), host, owner, repo, stack);
}
// Worktree mode: one shared clone per repo (the object store), at `.base`.
function baseClonePath(host: string, owner: string, repo: string): string {
  checkSafe('host', host); checkSafe('owner', owner); checkSafe('repo', repo);
  return join(workspaceRoot(), host, owner, repo, '.base');
}
// Worktree mode: a per-job working tree under `.wt`, keyed by branch ('/' is not a legal segment).
function worktreePath(host: string, owner: string, repo: string, headRef: string): string {
  checkSafe('host', host); checkSafe('owner', owner); checkSafe('repo', repo);
  const key = headRef.replace(/[^A-Za-z0-9._-]/g, '__');
  checkSafe('worktree', key);
  return join(workspaceRoot(), host, owner, repo, '.wt', key);
}

// Clone the repo at `path` if absent, else `fetch --prune`. Shared by legacy + base-clone modes.
async function ensureClone(path: string, opts: {
  host: string; owner: string; repo: string; token: string | null;
}): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  const present = await stat(path).then(() => true).catch(() => false);
  if (!present) {
    if (!opts.token) throw new GitError('git.pat_unavailable', `workspace ${path} missing and no PAT to clone`);
    const url = `https://${opts.host}/${opts.owner}/${opts.repo}.git`;
    const cloneTimeout = Number(process.env['EIDAN_GIT_CLONE_TIMEOUT'] ?? '') * 1000 || 600_000;
    const r = await git(['clone', url, path], { token: opts.token ?? undefined, timeoutMs: cloneTimeout }).catch(async (e) => {
      await rm(path, { recursive: true, force: true });
      throw e;
    });
    if (r.exitCode !== 0) {
      await rm(path, { recursive: true, force: true });
      throw new GitError('git.clone_failed', `clone failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500)}`);
    }
  } else {
    const fetchTimeout = Number(process.env['EIDAN_GIT_FETCH_TIMEOUT'] ?? '') * 1000 || 300_000;
    const r = await git(['fetch', '--prune', 'origin'], { cwd: path, token: opts.token ?? undefined, timeoutMs: fetchTimeout });
    if (r.exitCode !== 0) console.warn(`[sage/git] fetch failed at ${path}: ${r.stderr.slice(0, 200)}`);
  }
  return path;
}

// ── PreparedWorkspace + the pipeline API ────────────────────────────────────────

export interface PreparedWorkspace {
  path: string;
  // Worktree mode: the shared clone the worktree attaches to (to remove the worktree on release).
  // null in legacy shared-clone mode.
  basePath: string | null;
  repoId: string;
  // The repo_locks key this checkout holds (branch in worktree mode, stack in legacy).
  lockKey: string;
  leaseToken: string;
  host: string;
  owner: string;
  repo: string;
  stack: string;
  nodeId: string;
  headSha: string;
}

export type PatResolver = (opts: { host: string; ownerRepo: string; scope: 'read' | 'write' }) => string | null;

// Lease + refresh + check out a branch ready for editing. base provided → initial-work mode (fresh
// branch off origin/<base>, plus a synced local <base> for the critic + a valid `gh pr create --base`).
// base omitted → iteration mode (checkout the existing remote PR branch tip). Returns null when a
// peer holds the lease.
export async function preparePrWorkspace(
  db: Db,
  resolvePat: PatResolver,
  opts: { host: string; owner: string; repo: string; stack: string; nodeId: string; headRef: string; baseRef?: string },
): Promise<PreparedWorkspace | null> {
  const ownerRepo = `${opts.owner}/${opts.repo}`;
  const token = resolvePat({ host: opts.host, ownerRepo, scope: 'write' }) ??
    resolvePat({ host: opts.host, ownerRepo, scope: 'read' });

  const repoId = await getOrCreateRepo(db, opts.host, opts.owner, opts.repo);
  const worktrees = useWorktrees();
  // In worktree mode the lease is per-branch (concurrent same-repo jobs on different branches don't
  // contend); in legacy mode it's per-stack (one shared checkout). The headRef is unique per initial
  // job and shared per PR for iterations — exactly what the lease must serialise either way.
  const lockKey = worktrees ? opts.headRef : opts.stack;
  const leaseToken = await acquireLease(db, { repoId, lockKey, nodeId: opts.nodeId });
  if (leaseToken === null) return null;

  const startPoint = opts.baseRef !== undefined ? `origin/${opts.baseRef}` : `origin/${opts.headRef}`;
  let path: string;
  let basePath: string | null = null;
  try {
    if (worktrees) {
      basePath = await ensureClone(baseClonePath(opts.host, opts.owner, opts.repo),
        { host: opts.host, owner: opts.owner, repo: opts.repo, token });
      path = worktreePath(opts.host, opts.owner, opts.repo, opts.headRef);
      // Clear any leftover worktree at this path (a crashed prior run) before attaching a fresh one.
      await git(['worktree', 'remove', '--force', path], { cwd: basePath }).catch(() => undefined);
      await git(['worktree', 'prune'], { cwd: basePath }).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      const add = await git(['worktree', 'add', '--force', '-B', opts.headRef, path, startPoint], { cwd: basePath });
      if (add.exitCode !== 0) {
        throw new GitError(`git.exit_${add.exitCode}`, `worktree add ${opts.headRef} from ${startPoint} failed: ${add.stderr.slice(0, 300)}`);
      }
      if (opts.baseRef !== undefined) {
        // Local <base> branch (shared ref in the base clone) for the critic + `gh pr create --base`.
        const synced = await git(['branch', '-f', opts.baseRef, `origin/${opts.baseRef}`], { cwd: basePath });
        if (synced.exitCode !== 0) console.warn(`[sage/git] could not sync local base ${opts.baseRef}: ${synced.stderr.slice(0, 200)}`);
      }
    } else {
      path = await ensureClone(legacyWorkspacePath(opts.host, opts.owner, opts.repo, opts.stack),
        { host: opts.host, owner: opts.owner, repo: opts.repo, token });
      const checkout = await git(['checkout', '-B', opts.headRef, startPoint], { cwd: path });
      if (checkout.exitCode !== 0) {
        throw new GitError(`git.exit_${checkout.exitCode}`, `could not check out ${opts.headRef} from ${startPoint}: ${checkout.stderr.slice(0, 300)}`);
      }
      if (opts.baseRef !== undefined) {
        const synced = await git(['branch', '-f', opts.baseRef, `origin/${opts.baseRef}`], { cwd: path });
        if (synced.exitCode !== 0) console.warn(`[sage/git] could not sync local base ${opts.baseRef}: ${synced.stderr.slice(0, 200)}`);
      }
    }
  } catch (e) {
    // Prep failed after we took the lease — release it so the slot isn't wedged until it goes stale.
    await releaseLease(db, { repoId, lockKey, nodeId: opts.nodeId, leaseToken }).catch(() => undefined);
    throw e;
  }

  const head = await git(['rev-parse', 'HEAD'], { cwd: path });
  const headSha = head.exitCode === 0 ? head.stdout.trim() : 'unknown';

  return { path, basePath, repoId, lockKey, leaseToken, host: opts.host, owner: opts.owner, repo: opts.repo, stack: opts.stack, nodeId: opts.nodeId, headSha };
}

// Release a prepared workspace: drop the per-job worktree (worktree mode) then the lease. Safe to
// call once in a finally; tolerates a missing/partial worktree. Use this instead of releaseLease so
// worktrees are always cleaned up.
export async function releaseWorkspace(db: Db, prepared: PreparedWorkspace): Promise<void> {
  if (prepared.basePath) {
    await git(['worktree', 'remove', '--force', prepared.path], { cwd: prepared.basePath }).catch(() => undefined);
    await git(['worktree', 'prune'], { cwd: prepared.basePath }).catch(() => undefined);
    await rm(prepared.path, { recursive: true, force: true }).catch(() => undefined);
  }
  await releaseLease(db, { repoId: prepared.repoId, lockKey: prepared.lockKey, nodeId: prepared.nodeId, leaseToken: prepared.leaseToken });
}

// Stage all + commit. Returns the new SHA, or null when the tree was clean (coder made no edits).
export async function commitAll(path: string, message: string): Promise<string | null> {
  const staged = await git(['add', '-A'], { cwd: path });
  if (staged.exitCode !== 0) throw new GitError(`git.exit_${staged.exitCode}`, `stage failed: ${staged.stderr.slice(0, 300)}`);
  const clean = await git(['diff', '--cached', '--quiet'], { cwd: path });
  if (clean.exitCode === 0) return null;
  const commit = await git(['commit', '-m', message], { cwd: path });
  if (commit.exitCode !== 0) throw new GitError(`git.exit_${commit.exitCode}`, `commit failed: ${commit.stderr.slice(0, 300)}`);
  const head = await git(['rev-parse', 'HEAD'], { cwd: path });
  return head.exitCode === 0 ? head.stdout.trim() : null;
}

export async function currentHeadSha(path: string): Promise<string | null> {
  const r = await git(['rev-parse', 'HEAD'], { cwd: path });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

// Push branch, re-verifying the lease first (a peer may have force-claimed a stale lease mid-run).
// A non-fast-forward rejection throws git.upstream_diverged so the caller can retry force-with-lease.
export async function pushBranch(
  db: Db,
  resolvePat: PatResolver,
  opts: { prepared: PreparedWorkspace; branch: string; force?: boolean },
): Promise<void> {
  const { prepared } = opts;
  await verifyLease(db, { repoId: prepared.repoId, lockKey: prepared.lockKey, nodeId: prepared.nodeId, leaseToken: prepared.leaseToken });
  const token = resolvePat({ host: prepared.host, ownerRepo: `${prepared.owner}/${prepared.repo}`, scope: 'write' });
  if (!token) throw new GitError('git.pat_unavailable', `no write PAT for ${prepared.host}:${prepared.owner}/${prepared.repo}`);
  const args = ['push'];
  if (opts.force) args.push('--force-with-lease');
  args.push('origin', opts.branch);
  const r = await git(args, { cwd: prepared.path, token });
  if (r.exitCode !== 0) {
    const stderr = (r.stderr || '').toLowerCase();
    if (stderr.includes('non-fast-forward') || stderr.includes('rejected')) {
      throw new GitError('git.upstream_diverged', 'push rejected — remote moved; re-prepare and retry');
    }
    throw new GitError(`git.exit_${r.exitCode}`, `push failed: ${r.stderr.slice(0, 300)}`);
  }
}
