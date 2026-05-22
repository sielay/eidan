# `plugins/`

This directory holds eidan plugins. Each plugin is a self-contained
folder declared by a `plugin.yaml` — see
[`docs/001_PLUGINS.md`](../docs/001_PLUGINS.md) for the contract.

## What lives here

Only `tier: core` plugins ship in this repo. Paid-bundle plugins
live in private sibling repos and are dropped into this directory
on an operator's machine by the eidan CLI; they do not appear in
this repo's git history. See
[`docs/018_DISTRIBUTION_AND_BUNDLES.md`](../docs/018_DISTRIBUTION_AND_BUNDLES.md).

## Adding your own plugin

This directory is **gitignored by default**. The repo's `.gitignore`
allowlists only the named core plugins above. If you add a new
plugin folder here, `git status` won't show it — that's
intentional. Two paths from there:

- **Local-only / private bundle work.** Symlink or check out your
  plugin into `plugins/<name>/` and leave the `.gitignore` alone.
  Nothing leaks into PRs against this repo.
- **Contributing a new `tier: core` plugin upstream.** Add
  `!/plugins/<your-plugin>/` to the allowlist block in
  `.gitignore`, then commit. Core contributions require the CLA
  ([`docs/020_LICENSING_AND_CLA.md`](../docs/020_LICENSING_AND_CLA.md)).

The allowlist is the gate: nothing in `plugins/` reaches a PR
unless someone deliberately negated it.
