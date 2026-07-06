---
id: use-cases
title: Use cases
sidebar_position: 2
---

# Use cases

What eidan actually does — grouped by the part of your life it touches. Every example here is a
**real, shipped capability**, not a promise. Each notes the surface you'd use (web, Telegram,
voice, CLI) and the plugins involved.

:::tip Add yours
Doing something with eidan we should show here? Open an issue or PR on
[GitHub](https://github.com/sielay/eidan) — this page is curated from real sessions, and we'd
like it to grow with the community's.
:::

## Memory & capture

- **"Built the journal panel today; found a scoring bug in mathgame."** Drop a note — typed, or a
  voice note from Telegram — and eidan categorises it, logs it structurally, and routes it: a bug
  that names a repo opens a coding job, a content idea is kept for later.
  _Surface: Telegram / Voice / Web · Plugins: `journal`, `transcribe`, `jobs`._
- **"What did I decide about the pricing model, and why?"** Recall from a searchable, linked
  knowledge graph — not a scroll-back through chat history.
  _Surface: Web / CLI · Plugins: `memory`, `decisions`._

## Coding (Sage)

- **"Fix the flaky test in sielay/eidan and open a PR."** Sage branches, writes the change on an
  isolated worktree, self-reviews, opens the PR, and iterates on review comments + failing CI until
  it's green — you keep the merge button. Track it on a live board.
  _Surface: Web / Telegram · Bundle: Sage · Plugins: `jobs`, `github`._

## Business (Charles)

- **"Set up my new Ltd and pull its Companies House details."** A multi-entity ventures tree with
  nested projects; look up a UK company's registered identity into a venture.
  _Surface: Web · Bundle: Charles · Plugin: `charles-ventures`._
- **"Post this across my socials and tell me how the last one did."** Multiple accounts per
  platform (BYO-OAuth, sealed in the vault), post + listen across eight networks.
  _Surface: Web · Bundle: Charles · Plugins: `social-*`._

## Automation & agents

- **"Every weekday at 9am, brief me on my calendar and unread mail."** Stand up your own agents —
  each with a persona, its own model, and triggers (a schedule, a sensor, a webhook) — and see them
  on a live org chart. They escalate to you when unsure.
  _Surface: Web / Telegram · Plugins: `agents`, `escalations`, `ical`, `imap`._

## Self-hosting & privacy

- **"Run it on my own box, over my own mail and calendar, with keys the model never sees."**
  One node or many, all sharing one Postgres you control; credentials live in a per-user encrypted
  vault and are used by reference.
  _Surface: any · Plugins: `vault-postgres`, `storage-postgres`._
