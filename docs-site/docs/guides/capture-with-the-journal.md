---
id: capture-with-the-journal
title: Capture with the journal
---

# Capture with the journal

The **journal** is a front door to your memory with no lock: drop a note — typed or spoken — and the
agent categorises it, logs it structurally, and routes it.

## Drop a note

From the web chat or Telegram (voice notes are transcribed first), just say what happened:

> "Built the journal panel in eidan today; found a scoring bug in mathgame → sielay/mathgame."

The agent splits it into distinct items and records each with `journal_capture`:

- a **devlog** on `eidan` — kept for later content/planning
- a **bug** on `mathgame` with a repo — which opens a Sage coding job

## The direction prompt

How notes get sorted is governed by an editable **direction prompt** (one per user). Read or change
it any time:

> "Show me my journal direction prompt."
>
> "Update my journal direction: treat anything about finances as a `task` for Charles."

## Entry types & routing

| Type | Meaning | Routing |
|---|---|---|
| `devlog` | "I did / shipped X" | logged; feeds content/planning agents |
| `bug` / `task` | broken thing / concrete change | opens a Sage `code` job if it names a repo |
| `idea` | a thought to keep | logged |
| `content_seed` | worth turning into a post | logged for content agents |

## Read it back

Ask the agent to `journal_query` (filter by project / type / since) or browse the `/p/journal` panel
in the web app. Planning agents you set up (see [Build an agent](/guides/build-an-agent)) can read the
journal to draft blog posts or a weekly review.
