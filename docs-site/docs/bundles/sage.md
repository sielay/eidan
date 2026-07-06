---
id: sage
title: Sage — coding
---

# Sage — coding

**Sage** delegates real engineering work. Hand it a task in plain language — no GitHub issue
required — and it codes the change on an isolated workspace, self-reviews before opening the PR, then
loops on review comments and failing CI until it's mergeable. A jobs board tracks every task, and
mirrors GitHub on its own. **You keep the merge button.**

## Shipping today

- Delegate any coding task straight from chat — no GitHub issue needed
- A live jobs board: **Queued → Active → In review → Needs work → Done**
- Runs many jobs at once, each in its **own git worktree** — same-repo tasks never collide
- Codes in an isolated workspace and **self-reviews its diff** before opening the PR
- Reads review comments + failing CI and **pushes fixes until checks pass**
- The board mirrors GitHub: a merged PR moves to Done, a failing one back to Needs work, on its own

## Set it up

Add the Sage plugins (`sage`, plus `db`/`logs` if you want database and deploy-log tools) to your
`matbot.yaml`, and give it a GitHub token that can push and open PRs on your target repos (stored as a
secret in the vault). Then delegate from chat — see the
[Delegate coding to Sage](/guides/delegate-to-sage) guide.

## Works with

GitHub · Claude Code · GitHub Actions · Copilot.

## Roadmap

- Codex and Gemini as alternative coding engines
- Earned auto-merge for trusted repos
- Escalates to you when it gets stuck
- Pick the model/node per job, and grant scoped secrets to a task

---

Free and open source (AGPL), like the rest of eidan —
[on GitHub](https://github.com/sielay/eidan/tree/main/packages/sage).
