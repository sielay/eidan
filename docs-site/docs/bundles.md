---
id: bundles
title: Bundles
sidebar_position: 5
---

# Bundles

eidan's **core** is a complete agent on its own. **Bundles** are optional, free (AGPL) sets of
plugins that add a whole thematic capability — you enable one when you want it, and it composes with
the core through the same plugin/service seams. Only document what ships; roadmap items are marked.

## Core (always on)

Your own agent with structured, relational memory. Shipping today:

- Relational Postgres memory graph you can search, link, and export
- Talk to it in a web UI, a terminal REPL, or from Telegram — by text or voice — all over one memory
- Define your own agents (persona + model + triggers: schedule / sensor / webhook)
- A job queue you can watch on a board; recurring routines; escalations when it's unsure
- The **journal**: drop a note and it's categorised, logged, and routed
- Model-agnostic (Claude by default, OpenRouter and others per task)
- Calendar, mail and Drive built in; notifications out to Slack or Telegram
- Secrets in a per-user encrypted vault — used by reference, never shown to a model
- Open interop: MCP and A2A, in and out
- Shared planning boards (kanban with rich cards + typed refs)

## Sage — coding

Delegate engineering work straight from chat and watch it land.

- Delegate any coding task from chat — no GitHub issue needed
- A live jobs board: Queued → Active → In review → Needs work → Done
- Many jobs at once, each in its own git worktree
- Codes in an isolated workspace, self-reviews, opens the PR, and iterates on review + CI until green
- You keep the merge button

## Charles — business

An agentic back office for a portfolio of ventures.

- Ventures registry — a multi-entity tree (Ltd / sole-trader / holding) with nested projects
- Companies House identity lookup
- Social — multiple accounts per platform (BYO-OAuth), post + listen across 8 networks
- Books read-through — Xero and Stripe
- Market signals — Google Trends, Search Console, Trading 212
- Domain inventory (GoDaddy import) · Venture boards · Marp slide decks
- **Roadmap:** CRM (contacts, deals, pipeline), deeper books, a role-scoped agent family

## Charlotte — lifestyle

An AuDHD-first companion for the rhythm of your week. **In build** — see the
[roadmap on eidan.dev](https://www.eidan.dev/#bundles): fitness, nutrition, wellbeing, and proactive
nudges.

---

Next: **[Getting started](/getting-started)** to run the core, then enable a bundle from your
`matbot.yaml`.
