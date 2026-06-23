# @eidandev/sage (matbot bundle)

The Sage coding bundle, ported to the **matbot** runtime (part of the eidan core
pivot, `sielay/eidan#293`). It registers a `code` `JobHandler` on the eidan `jobs`
substrate (`@eidandev/jobs`): any `code` job enqueued on `eidan.jobs` routes here.

It collapses the four Python plugins (`gh` / `git` / `claude` / `sage`) into one TS
package that shells out to the `git` / `gh` / `claude` CLIs directly — the pipeline is
deterministic orchestration (the harness owns every git/PR mechanic; `claude` only
writes code), so it needs no separate agent-tool plugins.

## Status

This bundle is the TypeScript matbot port of the Python Sage coding loop and is
functionally complete. The full self-closing loop is implemented: claim→PR (workspace
lease, clone, code, push, PR open, Copilot review request), the Copilot/CI iteration
loop (triage, fix, resolve, advance cursor), and the OpenRouter self-review fallback for
when Copilot never engages.

## What it does (the self-closing loop)

1. **Claim → PR** (`pipeline.ts`): lease a per-`(repo, stack)` workspace, clone/branch,
   run `claude` to write the change, commit + push, open the PR, request a Copilot
   review, and seed the iteration cursor.
2. **Iterate** (`iteration.ts`, polled): on each settled, sage-managed PR — triage the
   open Copilot threads (`fix`/`reply`/`ack`/`escalate`) and failing CI checks
   (`autofix`/`fix`/`escalate`), apply the agreed fixes via `claude`, push, resolve the
   threads, and advance the cursor. Terminate clean (0 open threads AND green CI),
   `exhausted`/`waiting` at the iteration cap, or `escalated` when a verdict needs a human.
   Never auto-merges (`EIDAN_GH_MERGE_ALLOW` gates that).
3. **Self-review fallback** (`selfreview.ts`): when Copilot never engages and
   `OPENROUTER_API_KEY` is set, a cheap independent model stands in as the settle verdict.

State lives in the `sage` schema (`repos`, `repo_locks`, `pr_iterations`,
`review_findings`), ensured idempotently at `setup()` (also shippable via `sql/` +
`@eidandev/migrate`).

## Config (env — same names as the Python plugin)

| Var | Meaning |
|-----|---------|
| `EIDAN_DATABASE_URL` / `DATABASE_URL` | Postgres (required) |
| `EIDAN_GH_PATS` | JSON PAT roster (`[{host,target,scope,token}]`) routed by specificity. **For PRs into a repo owned by another account, the write entry must be a _classic_ PAT with `repo` scope** — fine-grained PATs `git push` fine but `gh pr create` 403s ("Resource not accessible") cross-account. Per-node override: set `EIDAN_GH_PATS__<node>` in `.env` (core `deploy/README.md`). |
| `EIDAN_NODE_ID` | node identity for the workspace lease |
| `EIDAN_CLAUDE_BIN` / `EIDAN_CLAUDE_OAUTH_TOKEN` | `claude` CLI path + auth (host-gated; Pi-only in the current deploy) |
| `EIDAN_SAGE_FIX_MODEL` / `EIDAN_SAGE_TRIAGE_MODEL` / `EIDAN_CLAUDE_DEFAULT_MODEL` | models |
| `EIDAN_SAGE_LOOP_MAX_ITERATIONS` (5) / `EIDAN_SAGE_LOOP_CONCURRENCY` (2) | loop caps |
| `EIDAN_GIT_WORKTREES` (off) | `1` = per-job git worktrees: many same-repo jobs run concurrently in independent working trees sharing one clone, lease re-keyed per-branch. Pair with core `EIDAN_JOBS_CONCURRENCY`>1; default off keeps the shared-clone-per-(repo,stack) path |
| `EIDAN_SAGE_POLL_INTERVAL` (60s) / `EIDAN_SAGE_LOOP_STALE` (PT45M) | poll cadence / stale-slot reclaim |
| `OPENROUTER_API_KEY` / `EIDAN_SAGE_SELFREVIEW_MODEL` | the self-review fallback (off if unset) |
| `EIDAN_SAGE_NOTIFY_TOPIC` (job.update) | which notify topic milestones post to |
| `EIDAN_SAGE_PONYTAIL` (full) | vendored [ponytail](./vendor/ponytail/VENDOR.md) "lazy senior dev" ruleset appended to every `claude` run via `--append-system-prompt` (the plugin's hook doesn't auto-fire in `--print`), plus `--plugin-dir` for its skills; `lite`/`full`/`ultra`, `off` to disable |

The node only registers the loop where a usable `claude` binary resolves (Pi-only in
the current deploy; Fly nodes reboot too often for `~/.claude/` to survive cold starts).

## Dev setup

The matbot engine is vendored as a submodule (`external/matbot`) and dev-linked from
each package. After cloning:

```bash
git submodule update --init external/matbot
pnpm install
pnpm -C packages/sage typecheck
node --import tsx packages/sage/smoke.test.mts   # pure-logic runtime smoke
```

## Not yet ported / open

- The agentic tool surface (the Python `gh_*` / `git_*` / `claude_run` tools an
  in-turn agent could call) — the loop drives the CLIs directly, so this is only needed
  if a bundle wants to expose them as tools again.
- The operator admin API (`admin_api.py`) + the pre-PR critic *gate* on open
  (`sage_open_pr` opens un-gated by design — review happens on the PR).
- `plugin_claude.runs` LLM cost/run telemetry — should route to core's `eidan.llm_calls`
  rather than living in sage.
- Live smoke-test on kesha — blocked on the matbot host being deployable (a core
  critical-path item) + an `eidan.escalations` writer to wire `escalate`.
