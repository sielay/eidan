# @eidandev/mcp-server

eidan's **inbound MCP server** — exposes a curated subset of eidan's tools over
the Model Context Protocol so external agents (Claude Code, other MCP clients)
can drive eidan memory. This is one of eidan's three interop boundaries (MCP in,
A2A in, AG-UI for the web UI). Pattern ported from potem's `apps/glue-web`: a
hand-rolled JSON-RPC 2.0 endpoint over HTTP POST, no MCP SDK.

It registers a matbot frontend (`mcp-server`) and starts a `node:http` server on
its own port. Because it exposes tools rather than agent-facing tools of its
own, there is no Tools table — what it speaks is below.

## What it exposes

A single JSON-RPC 2.0 endpoint on `POST :8091` (configurable). Handled methods:

- `initialize` → returns protocol version `2024-11-05`, `serverInfo {name: eidan}`.
- `notifications/initialized` → `202`.
- `tools/list` → the matbot tool registry filtered to the allowlist, each as `{name, description, inputSchema}`.
- `tools/call` → resolves the named tool (if allowed), drives it to completion under the caller's principal in a synthetic session/`ToolContext` (via `runAs`), and returns its reduced output as MCP `content: [{type:'text', text}]` with `isError`.

**Auth** (every method except none — all require a principal): a `Bearer` token
resolved by the `WebPrincipalResolver` service (same seam `auth`/`frontend-agui`
use), or an `X-MCP-Secret` header matched against `EIDAN_MCP_SECRET`, which maps
to the fixed `EIDAN_MCP_PRINCIPAL`. Unauthorized → JSON-RPC `-32001`.

## How consumed

Point any MCP client at `http://<host>:8091` with a Bearer JWT (or the shared
secret header). The client sees only the allowlisted tools (default
`remember`,`recall`) and calls them as normal MCP tools.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; registers the frontend, reads port/secret/allowlist env, and starts/stops the server.
- `src/server.ts` — `startMcpServer`: the HTTP + JSON-RPC dispatch, principal resolution, and `callTool` (synthetic session, `runAs`, event-stream reduction). Augments `MatbotServices` with `WebPrincipalResolver`.

## Schema

None of its own.

## Config

- `MATBOT_MCP_PORT` — listen port (default `8091`).
- `EIDAN_MCP_TOOLS` — comma list of exposed tool names (default `remember,recall`; `*` = all registered tools).
- `EIDAN_MCP_SECRET` + `EIDAN_MCP_PRINCIPAL` — optional shared-secret auth: requests with a matching `X-MCP-Secret` act as that principal id. If unset, only `WebPrincipalResolver` (Bearer) auth is accepted.
