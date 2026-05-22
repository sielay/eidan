# 016 — Repo sanitisation runbook for flat-commit release

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Release model, Dev notes),
`docs/001_PLUGINS.md` (§6 flat plugin layout — `plugins/<name>/`,
§1.1 manifest `tier:` field),
`docs/002_MIGRATIONS.md` (§1 tiering as bundle metadata, §1.1
paid baseline migration layer on the shared eidan schema),
`docs/010_COST_BUDGETING.md` (§4.4 per-user cap, §7
`cost-analytics` plugin — both ship in the universal paid baseline
sibling repo),
`docs/018_DISTRIBUTION_AND_BUNDLES.md` (canonical sibling-repo
distribution model),
`docs/011_AUTH_FLOW.md` (§3.2 single-operator pin — the public
shape eidan is released as),
`docs/012_SECRETS.md` (§3 static tier, env-var naming, what is
*not* a secret),
`docs/013_MCP_SURFACE.md` (§9.1 `eidan` CLI surface)

This document specifies the **runbook the operator follows to
sanitise this repo before a public release tag is cut**. The
release shape is a *flat commit*: the public mirror's history is
one squashed commit per tagged release, not a replay of this
repo's day-to-day history. The runbook is the bridge between the
two — it pins, for every release:

- The **file-level removals** that strip operator-internal
  artefacts: every `*_INTERNAL.md` doc anywhere in the tree, the
  `Dev notes` block inside `docs/ARCHITECTURE.md` (and any other
  markdown), the sensitive entries inside `.env.example`, and the
  private release tooling (`scripts/release/private/`,
  `.github/workflows/private-*.yml`).
- The **forbidden-string catalogue** (§4) — the list a
  verification grep runs against the public tree. The grep is the
  release's hard gate: a non-empty match aborts the release.
- The **branch procedure** (§5) — how the public flat commit is
  produced from this working repo, where the two remotes live, and
  how a release tag flows from one to the other.
- The **post-release verification** (§6) — what the operator does
  *after* the push lands on the public mirror: clone fresh from
  the public URL, run the smoke suite, re-run the forbidden-string
  grep against the fresh checkout.

**There is no tier-directory strip.** PRO and commercial code is
not in this repo to begin with — those tiers live in **standalone
private sibling repos** that the operator drops into their local
`plugins/` directory via `eidan plugins install` once they have
access (`docs/018 §2`, `001 §6`, `002 §1`). Earlier drafts of this
runbook described `rm -rf plugins/pro/` and similar steps; that
was overhead for a separation the directory layout no longer
encodes.

The runbook does not attempt to be a general-purpose
secret-scanner — the forbidden-string list in §4 is the curated
list of terms specific to eidan that should not appear in the
public tree, *additional* to whatever generic secret scanner
runs in CI.

Out of scope (deferred to follow-ups, see §9):

- The paid-bundle and commercial release tracks. Each paid bundle
  is its own standalone private sibling repo (`docs/018 §2`) with
  its own sanitisation needs (operator internals, license-protected
  entries, etc.); those runbooks are siblings to this one and not
  covered here.
- Generic secret scanning (gitleaks, trufflehog, detect-secrets).
  Those run in CI ahead of this runbook; §6.3 references them but
  does not redefine them.
- Continuous public mirroring (live one-to-one sync between the
  private and public repos). The release shape is explicitly
  *batched* — one flat commit per tagged release — and live
  mirroring is reserved against the unforeseen case where a
  consumer needs nightly snapshots (§9).
- License-text injection. The public LICENSE file is committed
  on the public mirror's `main` directly and is not derived from
  this repo; the runbook does not write or rewrite it.
- Git-history rewriting on the working repo. The runbook treats
  this repo's history as authoritative and immutable; the public
  flat commit is a fresh tree, not a rewritten history. See §5.3.
- A reverse path (public commits flowing back into this repo). The
  public mirror is read-only from this repo's perspective; external
  PRs are reviewed and re-applied by hand on this side. See §9.

---

## 1. Vocabulary

| Term                       | Meaning                                                                                                                                                                |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Working repo**           | This repository — `sielay/eidan` on the operator's git host, where this `docs/` lives. Carries the full development history of core plus operator-internal notes. PRO and commercial code is **not** here; those ship in **standalone private sibling repos** per `docs/018 §2`. |
| **Sibling bundle repos**   | Private repos (one per paid bundle plus the landing repo, enumerated in `docs/018 §2`) that hold the operator's proprietary plugins. The `eidan plugins install` CLI command imports + syncs them into an operator's local `plugins/` directory once they have access. Sync direction is upstream-per-repo, no cross-repo git history. Each has its own release track, not covered here. |
| **Public repo**            | The mirror at `eidan-os/eidan` (placeholder — pinned per release in `release/public-remote.txt`). Receives one flat commit per tagged release. Read-only for the public. |
| **Release tag**            | A semver tag (`vX.Y.Z`) on this repo's release branch. Triggers the runbook. The same tag is reproduced on the public mirror after the flat commit lands.              |
| **Sanitisation tree**      | A throwaway working tree, produced by the release script, that is this repo's tree minus operator-internal artefacts. The flat commit is taken from this tree.         |
| **Flat commit**            | A single `git commit-tree` against the sanitisation tree, with the public mirror's previous release commit as its sole parent (or no parent for the first release). The public mirror sees one commit per release, not this repo's history. |
| **Forbidden string**       | An entry in the §4 catalogue. A literal string (or regex with the `re:` prefix) that must not appear anywhere in the sanitisation tree. The grep in §3.6 is the hard gate. |
| **Dev notes block**        | A `<!-- DEV NOTES BEGIN --> … <!-- DEV NOTES END -->` HTML-comment-fenced region inside a markdown file. Authored by the operator for internal context; stripped before release. See §3.4. |
| **`*_INTERNAL.md`**        | Any markdown file whose basename ends in `_INTERNAL.md`. Carries operator-only commentary that does not survive release. Deleted wholesale (not edited) by §3.3.        |
| **Sensitive `.env.example` entry** | A line in `.env.example` whose key matches the curated `release/env-example-forbidden-keys.txt` list. Stripped by §3.5. Distinct from forbidden strings — these are *keys*, not values. |
| **Release script**         | `scripts/release/public-flat-commit.sh`. The end-to-end automation that performs the strips, runs the forbidden-string grep, and emits the flat commit. Hand-runnable; also wired as a CI job (§7.2). |

---

## 2. What is removed, what stays, and why

### 2.1 The principle

The split between core and PRO is a **contract**, not a secret.
This repo's specs reference PRO surfaces freely (`010 §4.4`'s
per-user cap, `011 §3.2`'s identity boundary, `002 §1.1`'s
migration layering) because those mentions describe the *seam* —
the API core commits to keeping stable when a paid-baseline plugin
plugs in on top. The mentions stay.

PRO and commercial **implementations** do not live in this repo:
no PRO plugin source, no PRO migrations, no PRO-internal design
docs. They live in the **standalone sibling bundle repos** per
`docs/018 §2`; an operator with access pulls them in via
`eidan plugins install`. So the runbook does not strip them —
there is nothing to strip. What it does strip is the
**operator-internal** layer: notes, scaffolding, private tooling
that exists alongside core code in this repo but should not
appear publicly.

Stated differently: a public reader should be able to read every
core spec end to end and understand exactly *what* PRO adds on
top of core, so they can decide whether to buy it, build their
own equivalent, or do without.

### 2.2 What gets removed

Operator-internal artefacts (every release, unconditionally):

| Pattern / file                                | Why                                                                                                  |
|-----------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `**/*_INTERNAL.md`                            | Internal-only markdown anywhere in the tree. See §1 vocabulary.                                      |
| `Dev notes` blocks in any markdown file       | HTML-comment-fenced operator commentary (`<!-- DEV NOTES BEGIN --> ... <!-- DEV NOTES END -->`). See §3.4. |
| `.env.example` — sensitive entries            | Lines whose key appears in `release/env-example-forbidden-keys.txt`. See §3.5.                       |
| `CHANGELOG-INTERNAL.md` (if present)          | Internal release narrative. The public mirror gets `CHANGELOG.md`; the `-INTERNAL` variant does not.  |
| `scripts/release/private/`                    | Operator-only release tooling (signing keys, push-key wrappers, release-notes templates with internal links). |
| `.github/workflows/private-*.yml` (glob)      | Tooling that references the private remote. Scrubbed by glob; tolerate empty.                        |

There is **no tier-directory strip** and no manifest-walking step
for plugins, because PRO and commercial trees never exist in this
repo (`001 §6`, `002 §1`). The release script asserts as a
post-condition that the tree contains no `plugins/<name>/` whose
`plugin.yaml` declares `tier: pro` or `tier: commercial`; a
non-empty result is a fatal abort, because it would mean
bundle-only content was checked into this repo by mistake.

### 2.3 What deliberately stays

To be explicit (because the temptation is always to over-strip):

| Item                                              | Why it stays                                                                                                                                |
|---------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| Every `PRO` / `pro/` mention in *core* specs      | They describe the API contract PRO consumes. Removing them would make the core specs incoherent. See §2.1.                                  |
| `migrations/` and `migrations/versions/`          | Core's schema is public. `002 §4` applies it unconditionally on every install.                                                              |
| The `potem` references                            | `potem` is the predecessor stack; legacy references survive in some specs but are not a forbidden term. The forbidden list (§4) explicitly notes this. |
| Every `plugins/<name>/`                           | This repo carries only `tier: core` plugins (`001 §6`); they are public. The runbook asserts this rather than strips by tier.               |
| `.env.example` keys *not* in the forbidden-keys list | The example env file is the operator's onboarding hint; only specific keys (PRO licence, internal telemetry endpoints) are stripped.    |
| Author identity in commit metadata                | The flat commit carries a release-bot author (§5.2) — this repo's per-commit authorship does not propagate, but the release author is intentionally public. |

---

## 3. The sanitisation runbook (ordered)

### 3.1 Pre-flight

Before the operator (or the release script) touches anything:

1. The working repo's tree is **clean** (`git status` reports no
   untracked or modified files). Sanitisation runs against a fresh
   checkout of the release tag, never against the operator's live
   workspace.
2. The release tag (`vX.Y.Z`) exists on this repo's release branch
   and points at a commit whose CI is green (lint, type-check,
   tests, generic secret scanner).
3. The forbidden-string catalogue (`release/forbidden-strings.txt`)
   and the env-key list (`release/env-example-forbidden-keys.txt`)
   are committed at HEAD. The runbook reads them from the
   sanitisation tree itself so each release uses the catalogue as
   of its own tag — not the operator's local mutable copy.
4. The public mirror's previous release commit hash is known
   (used as the flat commit's parent; §5.2). For the first
   release, the parent is empty.

A pre-flight failure aborts before the sanitisation tree is
written. The script prints one actionable line per failed check;
no cascading errors.

### 3.2 Phase 1 — operator-internal directory strips

Performed against the sanitisation tree (a checkout of the
release tag into a throwaway directory, never the operator's
workspace). The order is deterministic so a diff between two
releases is meaningful:

```
1. rm -rf scripts/release/private/
2. rm -rf .github/workflows/private-*.yml  (glob; tolerate empty)
```

That is the entire phase. PRO and commercial code is not in this
repo (`001 §6`, `002 §1`), so there is no tier-directory strip.

**Post-condition — bundle-only content must not be present.** Even
though the runbook does not strip by tier, it asserts that no
sibling-bundle content leaked into the open repo by mistake:

```
# no tier subdirectories anywhere
find . -type d \( -name pro -o -name commercial \) -not -path './node_modules/*'
# every plugin manifests as tier: core
for dir in plugins/*/; do
    tier="$(yq '.tier' "$dir/plugin.yaml")"
    test "$tier" = "core" || abort "non-core plugin in open repo: $dir ($tier)"
done
```

A non-empty `find` result or any non-`core` tier is a fatal abort
— the operator removes the offending content from this repo
(moving it to the corresponding sibling bundle repo per `docs/018
§2`) and re-tags.

### 3.3 Phase 2 — `*_INTERNAL.md` deletions

```
find . -type f -name '*_INTERNAL.md' -delete
```

Run from the sanitisation tree root. Reaches every level — the
convention is that any internal markdown anywhere in the repo
ends with `_INTERNAL.md`, not just top-level docs.

The post-condition is symmetric:
`find . -type f -name '*_INTERNAL.md'` must return empty after
the phase. A non-empty result means a delete failed (permissions
on the sanitisation tree; impossible in practice since it is a
fresh checkout owned by the running user). Fatal abort.

### 3.4 Phase 3 — Dev notes block removal

`docs/ARCHITECTURE.md` carries operator commentary in
HTML-comment-fenced blocks:

```markdown
<!-- DEV NOTES BEGIN -->
... operator-only commentary, internal links, TODOs ...
<!-- DEV NOTES END -->
```

The runbook strips every such block from every markdown file in
the tree (not only `docs/ARCHITECTURE.md` — the fence is the
contract, not the path; any operator adding a `Dev notes` block
in any other markdown file gets the same treatment for free).

The strip is a simple sed-equivalent that deletes inclusive of
both fence comments. Two invariants:

1. The strip is **idempotent**: re-running it on an
   already-stripped tree is a no-op (no fence pairs left).
2. The strip is **block-scoped**: it does not touch a markdown
   file that contains no fence. The release script does not
   rewrite files unnecessarily — a `git diff` against the
   release tag shows only the files that actually had blocks.

Unmatched fences (`BEGIN` without `END`, or vice versa) are a
fatal abort. The runbook does not silently strip half a block.
The operator fixes the source file on this repo and cuts a new
release tag.

### 3.5 Phase 4 — `.env.example` scrub

`release/env-example-forbidden-keys.txt` lists, one key per line,
the env-variable names whose lines must not appear in the public
`.env.example`. The runbook deletes any line in `.env.example`
whose left-hand side (before the first `=`) matches an entry on
that list, plus any preceding comment lines that document only
that key (a heuristic: comment lines that immediately precede the
deleted key and are themselves not separated from it by a blank
line).

Seed entries on the list (this is an initial seed; the list is
extended per-release as new keys land):

```
# release/env-example-forbidden-keys.txt
EIDAN_PRO_LICENSE_KEY
EIDAN_PRO_LICENSE_URL
EIDAN_INTERNAL_TELEMETRY_DSN
EIDAN_INTERNAL_OPS_WEBHOOK
EIDAN_COMMERCIAL_REGISTRY_TOKEN
```

The post-condition: a grep for any of those keys against the
sanitisation tree's `.env.example` returns empty. A non-empty
result is fatal — the comment-heuristic missed something; the
operator either adjusts the heuristic or pre-edits the source
file on this repo.

Note: this phase scrubs **keys**, not values. A leaked value
inside `.env.example` (a key name that *is* on the public list,
but with an internal hostname in its value) is caught by the
forbidden-string grep in §3.6 instead.

### 3.6 Phase 5 — forbidden-string grep (the hard gate)

The runbook's hard release gate. Reads `release/forbidden-strings.txt`
and runs a recursive grep against the sanitisation tree.

```
# pseudocode
forbidden = read_lines('release/forbidden-strings.txt')
for line in forbidden:
    if line.startswith('re:'):
        hits = ripgrep(pattern=line[3:], path=sanitisation_tree)
    else:
        hits = ripgrep(fixed_strings=line, path=sanitisation_tree)
    if hits: ABORT(line, hits)
```

Behaviour pins:

- Literal strings (the default) are matched with `rg -F` — no
  regex escaping headaches; entries can include slashes, dots,
  quotes verbatim.
- Regex entries are prefixed `re:` and passed through with
  `rg --regexp`. Reserved for genuine regex needs (case-fold
  variants, optional separators).
- The grep is **whole-tree** — no glob restrictions. A forbidden
  string in a binary asset (a PNG with an embedded comment, a
  PDF) trips the gate just as much as one in a `.py` file.
- A single hit is fatal. The runbook does not "score" — release
  goes through clean or not at all.
- The report lists every hit (file, line number, matched
  pattern) so the operator can fix in one pass rather than
  trial-and-error.

The catalogue itself is in §4; the grep is the mechanism that
enforces it.

---

## 4. Forbidden-string catalogue

### 4.1 What goes on the list

The list is intentionally **small and curated**. It is not a
universal blocklist of "anything that sounds internal"; it is
the specific terms whose appearance in the public tree would be
a problem.

Five categories of entry are admitted:

| Category                            | Example shape                                          | Why                                                                                          |
|-------------------------------------|--------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| **License / pricing tokens**        | `EIDAN_PRO_LICENSE_KEY`, `pro-tier-sku-`               | Operator-internal SKUs; never meant for the public README.                                   |
| **Internal telemetry / infra URLs** | `telemetry.eidan.internal`, `ops.eidan.internal`       | Hostnames inside the operator's private network. A leaked URL is a leaked attack surface.    |
| **Customer / partner identifiers**  | Specific names; pinned at the release tag, not here    | Each release adds names as they become covered by commercial agreements; never names removed. |
| **Internal codenames**              | Pre-announcement project names; reserved per-release   | Removed from the list once the codename ships publicly. Until then, the gate keeps it out.   |
| **Hard-coded sample secrets**       | `sk-test-` literals, internal-only API key prefixes    | Catches a key accidentally committed in an example.                                          |

### 4.2 What is **not** on the list

Equally important, to prevent the list from drifting into
over-strip:

- `pro`, `PRO`, `commercial` — these are part of the contract
  (§2.1). The *words* stay; the implementations live in their
  own sibling bundle repos (not in this repo).
- `potem` — the predecessor stack; legacy references in some
  specs. Not a forbidden term.
- The operator's own name / handle. The public author identity
  is `eidan-release-bot` (§5.2) on commits, but author names
  inside specs (`Owner: Core`, contributor credits in the
  CHANGELOG) are intentional.
- Third-party vendor names that core integrates with (Anthropic,
  Supabase, etc.). They appear by design.

### 4.3 Maintenance

`release/forbidden-strings.txt` is committed at the private
repo's HEAD and travels with the release tag. The runbook reads
it from the sanitisation tree, so each release's gate is
calibrated to the catalogue at its own tag — not the operator's
later additions.

A pull request that introduces a new plugin tier value (e.g.
`tier: enterprise`) must update §3.2's post-condition assertion
to either classify the tier as acceptable in this repo or to
abort. The release CI job (§7.2) is allowed to fail loudly the
first time an unrecognised tier value appears — that is the
prompt to update the runbook.

---

## 5. Branch procedure for the flat commit

### 5.1 The two-remote split

The release shape pins two remotes:

- **Working remote** (`origin`): this repo, where every-day commits
  land. Carries the full development history and operator-internal
  notes (Dev notes blocks, `*_INTERNAL.md`, private release tooling).
  PRO and commercial code is **not** here — those live in their own
  sibling bundle repos.
- **Public remote** (`public`): the read-only mirror. Carries
  exactly the flat commits produced by this runbook — one per
  release tag — plus the public mirror's own `LICENSE` and
  optional `CODE_OF_CONDUCT.md` committed directly to its main
  branch outside the runbook.

The public remote URL is pinned per-release in
`release/public-remote.txt`. The runbook reads it from the
sanitisation tree (so a release re-points to a new public
remote in the same PR that pins the new URL, no special-casing
needed).

### 5.2 The release script

`scripts/release/public-flat-commit.sh` is the end-to-end
automation. Hand-runnable; also wired as a CI job on the private
repo (§7.2). Its skeleton:

```bash
# scripts/release/public-flat-commit.sh
set -euo pipefail

TAG="${1:?usage: $0 <release-tag>}"   # e.g. v0.4.1

# 1. Pre-flight (§3.1)
require_clean_tree
require_tag_exists "$TAG"
require_tag_ci_green "$TAG"

# 2. Materialise the sanitisation tree
WORK="$(mktemp -d -t eidan-release-XXXX)"
git worktree add --detach "$WORK" "$TAG"
trap 'git worktree remove --force "$WORK"; rm -rf "$WORK"' EXIT

# 3. Phases (§3.2 – §3.6)
( cd "$WORK"
  apply_operator_internal_strips     # §3.2 (incl. bundle-only content assertion)
  apply_internal_md_deletions        # §3.3
  apply_dev_notes_strip              # §3.4
  apply_env_example_scrub            # §3.5
  run_forbidden_string_grep          # §3.6 — fatal on hits
)

# 4. Produce the flat commit
PUBLIC_REMOTE="$(cat "$WORK/release/public-remote.txt")"
PREV_COMMIT="$(git ls-remote "$PUBLIC_REMOTE" refs/heads/main \
              | awk '{print $1}')"

TREE="$(git -C "$WORK" write-tree)"
PARENT_FLAG=""
[ -n "$PREV_COMMIT" ] && PARENT_FLAG="-p $PREV_COMMIT"

GIT_AUTHOR_NAME="eidan-release-bot" \
GIT_AUTHOR_EMAIL="release@eidan.invalid" \
GIT_COMMITTER_NAME="eidan-release-bot" \
GIT_COMMITTER_EMAIL="release@eidan.invalid" \
COMMIT="$(git commit-tree "$TREE" $PARENT_FLAG -m "$TAG")"

# 5. Push to the public remote
git push "$PUBLIC_REMOTE" "$COMMIT:refs/heads/main"
git push "$PUBLIC_REMOTE" "refs/tags/$TAG"
```

The script is intentionally short: every phase is a function
defined in a sibling shell file, exit codes propagate via
`set -e`, and the working tree is a `git worktree` (not a copy)
so the original checkout is untouched.

Pins worth calling out:

- The author / committer on the flat commit is
  `eidan-release-bot <release@eidan.invalid>`. This repo's
  per-commit authors do not propagate to the public mirror. This
  is a deliberate flattening.
- The commit message is the bare tag (`v0.4.1`). Release notes
  live on the public release page (GitHub Releases, etc.),
  generated from `CHANGELOG.md` which itself ships in the public
  tree. The commit message does not duplicate them.
- The parent is the public mirror's previous main commit, fetched
  by `git ls-remote` at release time. No local stale clone of the
  public mirror is required — the script works from a fresh
  machine.
- The tag is pushed *after* the main commit so the public mirror
  is never momentarily ahead of where it claims to be.
- No force-push. The flat-commit chain is forward-only. A bad
  release is fixed by cutting `vX.Y.(Z+1)` with the correction,
  not by rewriting `vX.Y.Z`.

### 5.3 What the public history looks like

After the second release:

```
* abc123 v0.4.1                            (eidan-release-bot)
* def456 v0.4.0                            (eidan-release-bot)
```

Two commits, two tags. No branches beyond `main`. No merge
commits (the flat-commit chain is strictly linear). No author
names from this working repo.

A reader cloning the public mirror sees the latest release at
`main` and can `git checkout v0.4.0` to read the previous one.
The diff `v0.4.0..v0.4.1` is the substantive content of the
release — exactly the changes that survived sanitisation.

### 5.4 First release (no previous parent)

The first release skips the `-p $PREV_COMMIT` flag (the script
already handles this — `PARENT_FLAG=""` when `git ls-remote`
returns empty). The result is a root commit on `main`. Every
subsequent release chains off it.

### 5.5 Operator-driven vs. CI-driven runs

The script supports both:

- **Operator-driven**: the operator runs
  `scripts/release/public-flat-commit.sh v0.4.1` from this
  repo's checkout. SSH credentials for the public remote come
  from the operator's `~/.ssh`.
- **CI-driven**: a CI workflow on this repo runs the same script.
  The public remote's deploy key is held in CI secrets. See §7.2
  for the workflow shape.

The two paths are intentionally interchangeable; CI is the happy
path, the operator path is the fallback when CI is down.

---

## 6. Post-release verification

The release does not end at the push. The verification phase
runs against the **public mirror** as the public would see it,
not against the sanitisation tree the script built.

### 6.1 Fresh-clone test

From a clean directory (a CI runner, the operator's other
machine, anywhere with no working-repo state on disk):

```
git clone https://<public-remote>/eidan.git eidan-public
cd eidan-public
git log --oneline             # exactly the public commits, no leakage
test ! -d scripts/release/private
# no tier subdirectories anywhere
test -z "$(find . -type d \( -name pro -o -name commercial \) -not -path './node_modules/*')"
# every remaining plugin must declare tier: core
for d in plugins/*/; do
    tier="$(yq '.tier' "$d/plugin.yaml")"
    test "$tier" = "core" || { echo "leaked plugin: $d ($tier)"; exit 1; }
done
```

A failure here is a fatal release abort — the operator pulls
the tag from the public mirror immediately and investigates.
Such a failure can only happen if §3.2's post-condition check
was bypassed (the runbook should already have caught it), but
the verification phase is what closes the loop.

### 6.2 Re-grep against the public clone

Re-run the §3.6 forbidden-string grep, this time against the
fresh public clone:

```
rg -F -f release/forbidden-strings.txt .
# expected: no hits
```

The catalogue is itself part of the public tree, so the grep
is self-bootstrapping — the public reader can audit the gate
the runbook ran. The grep against the fresh clone is the second
opinion: if §3.6 had a bug and let a forbidden string slip
through, the re-grep catches it before the release notes
publish.

### 6.3 Generic secret scanner

The release CI runs a generic secret scanner (gitleaks /
trufflehog) against the fresh public clone, with the standard
ruleset (no eidan-specific tuning beyond §4's catalogue, which
runs alongside). A non-zero exit is a release abort.

### 6.4 Smoke run

The release artefact is a runnable checkout. The verification
phase confirms it actually runs:

1. `eidan install` — installs the plugins present in the public
   tree (all of which declare `tier: core`).
2. `eidan host serve --transport stdio` — boots the host on
   stdio (`013 §3.2`), no network bind required.
3. `eidan mcp list-tools` — lists the public tool catalogue.
   The list MUST match `013 §3.4`'s core catalogue with no
   `eidan.import.*` and no PRO-only tools surfacing.

A smoke failure is a fatal release abort. The operator's
recourse is the same as §6.1's: pull the tag, fix the source,
cut a new release.

### 6.5 Sign-off

The verification phase ends with a single-line summary printed
to the release CI job log:

```
v0.4.1: public clone clean (no leaked dirs, 0 forbidden strings,
0 secret-scanner hits), smoke green.
release.json @ release-artefacts/v0.4.1/
```

`release.json` is the structured equivalent (counts per phase,
timestamps, hashes of the public tree). It is the audit
artefact — committed to a separate private archive bucket, not
back into either repo.

Exit code 0 requires every clause. Exit code 1 indicates any
failed gate; the public mirror's tag and main commit are
*not* rolled back automatically (no force-push), but the public
release-page draft is held back until the operator either fixes
forward (cut `vX.Y.(Z+1)`) or annotates the failed release.

---

## 7. Automation hooks

### 7.1 What is one command vs. several

A release should be one command from the operator's seat:

```
$ scripts/release/release.sh v0.4.1
```

Internally, `release.sh` calls:

1. `scripts/release/public-flat-commit.sh v0.4.1` (§5.2)
2. `scripts/release/verify-public.sh v0.4.1` (§6)
3. `scripts/release/post-release-notify.sh v0.4.1` — posts the
   release notes draft, archives `release.json`, notifies the
   operator (the only step that touches anything beyond git).

Each sub-script is independently runnable for debugging. The
top-level script is the happy path.

### 7.2 CI workflow shape

A CI workflow on this repo watches for tag pushes matching
`v*.*.*`:

```yaml
# .github/workflows/private-release.yml  (lives on this repo)
on:
  push:
    tags: ['v*.*.*']
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Sanitise + flat-commit
        run: scripts/release/release.sh "${GITHUB_REF_NAME}"
        env:
          PUBLIC_DEPLOY_KEY: ${{ secrets.PUBLIC_MIRROR_DEPLOY_KEY }}
```

This workflow file itself is matched by the `private-*.yml`
glob in §3.2 — the public tree does not see it. A reader of the
public mirror finds no `release.yml` describing the gate; they
find the runbook (this doc) instead, which is the authoritative
description.

### 7.3 Manual override

The runbook deliberately allows a manual override: the operator
running `release.sh` on a laptop with the public-remote ssh key
in `~/.ssh` is a supported path. The override exists so a CI
outage never blocks a release — the runbook's invariants are
all enforced inside the script, not by CI's framing.

The price is that an operator who skips parts of the script
(`run_forbidden_string_grep`, say) can produce a release that
fails verification. §6 is what catches them. The runbook's
shape is "automate everything, but make manual fall-through
honest."

---

## 8. Sequencing relative to other release steps

A release is more than the runbook. The sequencing constraints
stack as:

1. The release commit lands on this repo's release branch with CI
   green (lint, type-check, tests, generic secret scanner).
2. The operator tags the commit `vX.Y.Z`.
3. The tag push triggers `release.sh` (§7).
4. `release.sh` runs the sanitisation phases (§3.2 – §3.6).
5. The flat commit pushes to the public mirror (§5.2).
6. The verification phases run against the fresh public clone
   (§6.1 – §6.4).
7. On verification pass, the release notes draft is published
   (`post-release-notify.sh`). On fail, the operator decides:
   fix forward, annotate, or escalate.
8. The paid-bundle and commercial release tracks (separate, not in
   scope here — each bundle ships from its own sibling repo per
   `docs/018 §2`) consume the same tag and produce their own
   artefacts in parallel.

This repo's release track and the public mirror's history are
loosely coupled: they share a tag, but the public mirror's
history is independent. A botched public release does not roll
back this repo's tag; a botched CI run does not strand a partial
public commit (the script's `set -euo pipefail` ensures the push
is the last step, after every gate passes).

---

## 9. Reserved for later specs

Deliberately out of scope, to be specified in follow-ups:

- **Continuous mirroring.** The current shape is batched — one
  flat commit per tag. A future spec describes a nightly /
  continuous mirror that pushes a flat commit per merged PR,
  for consumers who want lower latency than tagged releases.
  The runbook's phases are reusable verbatim; only the trigger
  changes.
- **Public PR ingestion.** A future spec describes how an
  external contributor's PR on the public mirror is reviewed and
  re-applied on this working repo. Today the public mirror is
  read-only; PRs are received via issue or email.
- **Multi-tier public releases.** If a "free PRO" tier is ever
  cut (PRO source open with a non-OSS license, distributed via
  a public mirror separate from core), the runbook gains a
  second sanitisation target. The release script becomes
  parameterised over a target name; the shape generalises
  cleanly.
- **License-text injection.** The public LICENSE file is
  committed directly on the public mirror today. A future spec
  describes deriving it from a SPDX identifier in this repo so
  the public LICENSE never drifts from the operator's intent.
- **Release-artefact signing.** Tag signatures and provenance
  (sigstore / cosign) for the flat commit. The current shape
  is unsigned; signing is reserved against the case where a
  downstream consumer needs verifiable provenance.
- **Tree-hash reproducibility.** A property worth pinning: two
  invocations of the runbook against the same tag MUST produce
  identical sanitisation trees (and therefore identical flat
  commit hashes, modulo author/committer dates). The current
  script is close to this property but does not enforce it; a
  future spec pins it as a CI invariant.
- **PRO / commercial release tracks.** Each bundle is its own
  standalone private sibling repo (`docs/018 §2`); the operator
  with access pulls each one in via `eidan plugins install`. PRO
  bundles ship as license-gated source drops; commercial bundles
  ship as binaries or vendored modules per the operator's
  agreement. They draw from their own repos, not this one.
  Their release runbooks are siblings to this one; this doc does
  not cover them.
