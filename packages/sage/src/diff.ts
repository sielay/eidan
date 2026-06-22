// SPDX-License-Identifier: AGPL-3.0-or-later
// Load a three-dot PR diff for the triage classifiers — port of diff.py. Shells out to git directly
// (reuses git.ts's subprocess) to resolve refs + merge-base + the introduced patch. The patch is
// `git diff merge-base..head`, i.e. what head introduced since it diverged — what GitHub shows.
import { git } from './git.js';

const SAFE_REF = /^(?!-)[A-Za-z0-9._/+~^-]{1,200}$/;
function checkRef(label: string, value: string): void {
  if (!SAFE_REF.test(value)) throw new Error(`sage.bad_refs: ${label} fails the safe-name check: ${value}`);
}

export interface DiffResult { baseSha: string; headSha: string; mergeBaseSha: string; patch: string }

export async function loadDiff(opts: { cwd: string; baseRef: string; headRef?: string }): Promise<DiffResult> {
  const headRef = opts.headRef ?? 'HEAD';
  checkRef('base_ref', opts.baseRef);
  checkRef('head_ref', headRef);

  // --end-of-options (not a bare --) so a ref can't be read as a flag, while keeping it a revision.
  const base = await git(['rev-parse', '--verify', '--end-of-options', `${opts.baseRef}^{commit}`], { cwd: opts.cwd, timeoutMs: 30_000 });
  if (base.exitCode !== 0) throw new Error(`sage.bad_refs: base_ref ${opts.baseRef} not resolvable: ${base.stderr.slice(0, 200)}`);
  const baseSha = base.stdout.trim();

  const head = await git(['rev-parse', '--verify', '--end-of-options', `${headRef}^{commit}`], { cwd: opts.cwd, timeoutMs: 30_000 });
  if (head.exitCode !== 0) throw new Error(`sage.bad_refs: head_ref ${headRef} not resolvable: ${head.stderr.slice(0, 200)}`);
  const headSha = head.stdout.trim();

  const mb = await git(['merge-base', baseSha, headSha], { cwd: opts.cwd, timeoutMs: 30_000 });
  if (mb.exitCode !== 0) throw new Error(`sage.diff_failed: merge-base failed: ${mb.stderr.slice(0, 200)}`);
  const mergeBaseSha = mb.stdout.trim();

  const d = await git(['diff', '--no-color', `${mergeBaseSha}..${headSha}`], { cwd: opts.cwd, timeoutMs: 30_000 });
  if (d.exitCode !== 0) throw new Error(`sage.diff_failed: diff failed: ${d.stderr.slice(0, 200)}`);

  return { baseSha, headSha, mergeBaseSha, patch: d.stdout };
}
