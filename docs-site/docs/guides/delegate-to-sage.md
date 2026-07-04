---
id: delegate-to-sage
title: Delegate coding to Sage
---

# Delegate coding to Sage

**Sage** is the coding bundle. Hand it a task in plain language and it does the engineering —
branches, writes the change on an isolated workspace, self-reviews, opens the PR, and iterates on
review comments and failing CI until it's green. You keep the merge button.

## Enable it

Sage is a free (AGPL) bundle. Add its plugins (`sage`, plus `db`/`logs` if you want them) to your
`matbot.yaml`, and give it a GitHub token with permission to push and open PRs on the target repos
(configured as a secret in the vault / `EIDAN_GH_PATS`).

## Delegate a task

From chat — no GitHub issue required:

> "Delegate to Sage: the conversation list over-fetches in `sielay/eidan`; make it return only
> metadata + a last-message preview, and open a PR."

Sage enqueues a `code` job and a node serving that kind picks it up.

## Watch it on the board

Every task moves across a live jobs board:

**Queued → Active → In review → Needs work → Done**

- Runs many jobs at once, each in its **own git worktree**, so same-repo tasks never collide.
- Codes in an isolated workspace and **self-reviews its diff** before opening the PR.
- Reads review comments + failing CI and **pushes fixes until checks pass**.
- The board mirrors GitHub on its own: a merged PR moves to Done, a failing one back to Needs work.

{/* TODO(screenshot): the Sage jobs board with cards across the lifecycle columns. */}

## You keep control

Sage never auto-merges — it opens the PR and gets it green; **you** press merge. When it gets stuck,
it lands an item in your [escalations](/concepts) inbox rather than guessing.
