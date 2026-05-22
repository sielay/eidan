---
title: eidan
description: Self-hosted personal agent OS for builders. Own your cognitive infrastructure.
template: splash
hero:
  tagline: Self-hosted personal agent OS for builders. Own your cognitive infrastructure.
  actions:
    - text: Quickstart
      link: https://github.com/sielay/eidan#quick-start
      icon: rocket
      variant: primary
    - text: Architecture
      link: ./architecture/
      icon: open-book
      variant: minimal
---

You run eidan on your own server, computer, raspberry, pod, whatever. It keeps long-running memory — conversations, notes, and whatever your tools feed in — in a Postgres database that's yours to read, back up, and walk away with. New features arrive as plugins: one folder can add backend code, a UI screen, its own database tables, agentic behaviours, and an MCP server.

The core is open source **forever**.

## Where to start

- **Quickstart** — the minimum-steps recipe lives in the [README](https://github.com/sielay/eidan#quick-start).
- **Operate locally** — see [Localhost](./localhost/) for devcontainer and bare-metal paths.
- **Understand the system** — [Architecture](./architecture/) covers the agentic loop, memory model, and plugin contract at a glance.
- **Reference** — the numbered **Specs** in the left navigation are the authoritative source; this site links into them.
