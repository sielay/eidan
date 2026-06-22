## Unreleased

### 2026-06-22 — PR-state reconciler (board mirrors GitHub)

- **`reconcile.ts` (`startPrReconcile`)**: a poll that mirrors each settled `code` job's PR state from
  GitHub back onto `eidan.jobs.result.pr_state`, so the board's lifecycle phase tracks reality without
  the operator touching it — a PR **merged by anyone** (human or agent) = review done → **Done**; a
  **closed-unmerged** or **CI-failing** PR → **Needs work**. Posts a milestone on each transition.
  Reuses `gh.checks()` + the new `gh.prStatus()`; runs alongside the Copilot/CI iteration poll (the
  active half — it reads reviews/threads and pushes fixes). Polls every `EIDAN_SAGE_POLL_INTERVAL`.

### 2026-06-22 — per-job git worktrees (opt-in same-repo parallelism)

- **`EIDAN_GIT_WORKTREES=1`** (`git.ts`): runs each job in its own `git worktree` under `.wt/<branch>`, all attached to one shared `.base` clone per repo, instead of a single shared checkout per `(repo, stack)`. The workspace lease is re-keyed **per-branch** (headRef) in this mode, so concurrent same-repo jobs on different branches no longer false-contend (they did under the `(repo, stack)` lease); same-PR iterations still serialise (same branch). `releaseWorkspace()` removes the worktree + prunes on release; leftover worktrees from crashed runs are cleared before re-attaching. Default off keeps the proven shared-clone path. Pairs with core `EIDAN_JOBS_CONCURRENCY`>1 — without per-job worktrees, concurrent same-repo jobs just `requeue` on the lease.

### 2026-06-15 — vendored ponytail "lazy senior dev" ruleset

- **Ponytail bias on every `claude` run** (`vendor/ponytail/`, `claude.ts`, `config.ts`): the deterministic coder + review-fix passes append the vendored, MIT, unmodified [ponytail](./vendor/ponytail/VENDOR.md) ruleset (v4.6.0, pin `687c1b3`) via `--append-system-prompt`, putting the coder in YAGNI/stdlib-first mode. The plugin is also loaded via `--plugin-dir` for its `/ponytail-review`/`-audit`/`-debt` skills. **On-host finding:** `--plugin-dir` alone does not bias the coder — the plugin's `SessionStart` hook does not inject its ruleset in non-interactive `claude --print` runs — hence the system-prompt path. Gated by `EIDAN_SAGE_PONYTAIL` (default `full`; `lite`/`ultra`/`off`). Needs `node` on PATH (matbot already requires it).

### 2026-06-12 — TypeScript matbot port complete

- **Claim → PR pipeline** (`pipeline.ts`): job claim from `eidan.jobs`, workspace lease, clone, `claude` CLI code pass, push, PR open, and Copilot review request.
- **Copilot/CI iteration loop** (`iteration.ts`, `triage.ts`): polls PR checks; triages findings; applies fix passes via `claude`; resolves addressed review threads; advances until CI is green or the iteration cap is reached.
- **OpenRouter self-review fallback** (`selfreview.ts`, `critic.ts`): when Copilot does not engage on an open PR, a cheap OpenRouter model reviews the diff as the settle verdict; CI-red folds into the blocking set so a clean diff is never marked done while a check is failing.
- **Tracking & schema** (`tracking.ts`, `schema.ts`, `sql/0001_sage.sql`): iteration cursors stored in `sage.pr_iterations`, with `sage.repos` / `sage.repo_locks` (workspace lease) and `sage.review_findings` (audit log); schema ensured at setup and shipped as `sql/` for the migrate path.
- **Smoke gate** (`smoke.test.mts`): TypeScript typecheck + import smoke test replacing the previous Python pytest job in CI.
- **Escalation inbox** (`escalations.ts`): the iteration loop's escalate/stall now mirrors to core's `eidan.escalations` (severity `medium`; `ambiguous_intent`, or `no_progress` at the cap), not just a PR comment.
