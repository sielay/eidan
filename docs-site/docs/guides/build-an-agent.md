---
id: build-an-agent
title: Build an agent
---

# Build an agent

Beyond the default assistant, you can stand up your **own agents** — each with a persona, its own
model, and one or more triggers. They run under your identity with your tools, and record every run
so you can see what they did.

## Create one

From chat, describe the agent and how it should fire:

> "Create an agent called 'Morning brief' — every weekday at 08:00, summarise my calendar and unread
> mail and send it to my Telegram."

Under the hood this creates an `agents` row (persona + model) and a **schedule trigger**. You can
also manage agents from the Agents screen in the web app.

## Triggers

- **schedule** — a time or cron-like window (`"mon,wed 14:00"`, `"every 30 minutes"`).
- **sensor** — fires on new events (schema in place; dispatch is maturing).
- **webhook** — fires on an inbound call.
- **response / decision gate / agent-to-agent** — react to an answered escalation, pause for a
  decision, or delegate to another agent.

## Wire an agent org

Agents can relate to each other — delegate work down, escalate findings up — and you see the graph on
a live org chart. When an agent is unsure, it lands an item in your **escalations** inbox instead of
guessing.

## A planning agent that reads your journal

A common pattern: a weekly agent whose persona calls `journal_query` and drafts content.

> "Create a weekly agent 'Blog planner' — every Friday, read my eidan journal entries from the past
> week and draft two blog-post outlines."

This composes two primitives — the [journal](/guides/capture-with-the-journal) and scheduled agents —
with no new code. That's the point: capabilities that call each other.
