<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0014 — Interop surfaces (MCP + A2A) and the matbot dependency

Status: **Shipped** — `@eidandev/mcp-server`, `@eidandev/a2a-server`.

## Inbound MCP — `mcp-server`

Exposes eidan's tools to **external agents** over MCP (JSON-RPC), on `:8091`. By default it surfaces
the memory tools (`remember`, `recall`) so another agent can read/write eidan's relational memory;
the exposed set is configurable. This is the *inbound* side — matbot's own MCP client is the outbound
side (eidan calling other MCP servers).

## Inbound A2A — `a2a-server`

Exposes eidan as an **A2A agent** (agent-to-agent protocol) on `:8095`:

- `GET /.well-known/agent-card.json` — the discovery document (`a2a-card.ts#agentCard`): identity
  (name/description/url) + protocol fields (`protocolVersion 0.2.5`, capabilities, text in/out, a
  `chat` skill). Pure + unit-tested.
- `POST` (JSON-RPC `message/send`) — runs the message's text as a turn under the resolved principal
  and returns the result. Errors use JSON-RPC codes (`-32700` parse, `-32001` unauthorized, `-32601`
  method not found, `-32602`/`-32603`).

Both servers resolve the caller's `Principal` and run under it, so external callers are scoped like
any other surface.

## The matbot dependency (vendored fork)

`external/matbot` is a git submodule. It tracks **`sielay/matbot` (a public fork) on the
`eidan-integration` branch** — `MatAtBread/matbot` base plus the two changes eidan needs that are
still in upstream review:

- **#2** `feat(vault)` — swappable Vault backend via `register('Vault')` (what `vault-postgres`
  needs).
- **#3** `fix(runner)` — commit the session per-message so an interrupted turn isn't lost whole.

**Lifecycle:** when upstream `MatAtBread/matbot` merges a PR, drop it from `eidan-integration` and
re-point the submodule; once both land, return `.gitmodules` to upstream. Contribute engine changes
upstream, not by editing `external/matbot/**` in this repo.

## Files of record

- `packages/mcp-server/src/` — inbound MCP (JSON-RPC) server.
- `packages/a2a-server/src/server.ts` — inbound A2A server; `a2a-card.ts` — the agent card builder.
- `.gitmodules` — the submodule URL (currently the fork).
