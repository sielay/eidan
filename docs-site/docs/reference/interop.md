---
id: interop
title: Interop (MCP · A2A · AG-UI)
---

# Interop — MCP · A2A · AG-UI

eidan speaks three open protocols on three boundaries, **in and out**, so it plugs into an existing
stack instead of replacing it.

## MCP — tools

The **Model Context Protocol** is eidan's tool boundary.

- **In:** the `mcp-server` plugin exposes eidan's own tools to external agents (Claude Code, other MCP
  clients), served on `:8091`.
- **Out:** the engine is an MCP client too, so eidan can call tools on external MCP servers — extend
  its reach without writing a plugin.

## A2A — agents

The **Agent-to-Agent** boundary lets *other agents* delegate to eidan. The `a2a-server` plugin
exposes eidan as an A2A agent (on `:8095`), so a larger multi-agent system can hand it work and
consume its result.

## AG-UI — the chat wire

**AG-UI** is the protocol between the agent and a frontend. It's the wire behind the web chat
(`POST /api/turn`, served on `:8090`) — a streaming turn API the reference Next.js app renders. Build
your own frontend against it if you don't want the reference one.

## At a glance

| Protocol | Boundary | Direction | Plugin / surface | Port |
|---|---|---|---|---|
| MCP | Tools | in + out | `mcp-server` (+ engine MCP client) | `:8091` |
| A2A | Agents | in | `a2a-server` | `:8095` |
| AG-UI | Frontend | — | `frontend-agui` (`/api/turn`) | `:8090` |

Because these are open standards, eidan is a citizen of the wider ecosystem rather than a walled
garden — the same reasoning behind [owning your stack](https://www.eidan.dev/#own-your-stack).
