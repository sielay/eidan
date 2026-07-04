---
id: plugins
title: Plugin catalogue
---

# Plugin catalogue

Every capability in eidan is a plugin — one folder you can read, fork, and enable in `matbot.yaml`.
This mirrors the released set in [`sielay/eidan/packages/`](https://github.com/sielay/eidan/tree/main/packages).
Core plugins are always on; bundle plugins are opt-in.

## Core (AGPL, always on)

| Plugin | What it does |
|---|---|
| Memory | Relational long-term memory — a Postgres knowledge graph it reads, links, and you can export. |
| Keen storage | Append-only persistence — every message lands in Postgres before the model replies. |
| Secrets vault | Per-user encrypted vault (Fernet at rest) — the agent uses keys it never sees. |
| Secure entry | An LLM-free write path for secrets, so values never touch a prompt. |
| Cost ledger | Per-call token + cost tracking. |
| Jobs | Delegation work-queue — hand work off by capability and track it to done. |
| Agents | User-defined agents — a persona, its own model, and triggers (schedule / sensor / webhook). |
| Routines | Recurring prompts — "every morning at 08:00, brief me." |
| Escalations | A human-in-the-loop inbox — it flags you when it's unsure. |
| Decisions | A searchable log of what was decided and why. |
| Procedures | Sandboxed JS the agent writes to compose its own tools in an isolated VM. |
| Notify | Outbound events routed to Slack or Telegram. |
| Journal | Drop a text/voice note; it's categorised, logged, and routed. |
| Voice | Speech-to-text via any Whisper-compatible endpoint. |
| Mail · Calendar · Gmail · Drive | Read-through IMAP/SMTP, `.ics`, Gmail, and Google Drive over your own accounts. |
| Reddit research | Market-trend and pain-point research across Reddit. |
| Web chat · Telegram | The AG-UI turn API behind the web app, and Telegram chat. |
| MCP server · A2A | Expose eidan's tools over MCP; let other agents delegate over A2A. |
| Telemetry · Tool guard | Node heartbeats + activity stream; trims oversized tool results. |

## Sage — coding

Sage, Databases, Logs.

## Charles — business

Ventures, Decks, Domains, Bluesky, Mastodon, Threads, Instagram, Facebook, LinkedIn, X, YouTube,
Trading 212, Google Trends, Search Console.

## Engine (from matbot)

Workspace, HTTP, Ask-user, Background, Skills, Cognition, Rumsfeld, Tool store.

:::note
This table is maintained by hand for now. It's a goal to generate it from `packages/*` + the live
`/api/plugins` so it can't drift — see the docs README.
:::
