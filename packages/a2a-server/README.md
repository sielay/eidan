# @eidandev/a2a-server

eidan's **inbound A2A server** — exposes eidan as an Agent-to-Agent (A2A) agent
so *other* agents can delegate to it: publish a public agent card for discovery,
then accept `message/send` calls that run a full eidan turn and return the
result as an A2A Task. This is the third interop boundary after MCP (`mcp-server`)
and AG-UI (`frontend-agui`); like MCP it is JSON-RPC 2.0 over HTTP and reuses the
same `WebPrincipalResolver` seam.

It registers a matbot frontend (`a2a-server`) and starts a `node:http` server.
Because it exposes an agent over a protocol rather than agent-facing tools of its
own, there is no Tools table — what it speaks is below.

## What it exposes

A `node:http` server on `:8095` (configurable), CORS-open:

- `GET /.well-known/agent-card.json` (and legacy `/.well-known/agent.json`) — the **public** agent card (no auth): name, description, url, `protocolVersion 0.2.5`, `capabilities {streaming:false, pushNotifications:false}`, text in/out modes, and a single `chat` skill.
- `POST /a2a` — JSON-RPC 2.0. Method `message/send`: extracts the first text part, maps the A2A `taskId` to an eidan session (continuation reuses the task), runs a turn under the resolved principal via `services.run.open` (provider configurable), and returns a completed Task whose `response` artifact carries the last assistant text.

**Auth:** `message/send` resolves identity via `WebPrincipalResolver` if present,
else falls back to the ambient/boot principal; a resolver throw → JSON-RPC
`-32001`. The agent card is intentionally unauthenticated (discovery).

## How consumed

An A2A client fetches the well-known agent card to discover eidan, then POSTs
`message/send` to the card's `url` (default `http://localhost:8095/a2a`) with a
text part; it gets back a Task with the agent's reply.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; registers the frontend, reads port/provider/name/url env, captures the boot principal, and starts/stops the server.
- `src/server.ts` — `startA2AServer`: HTTP routing, CORS, principal resolution, and `messageSend` (taskId↔session mapping, `runAs`, `run.open` event loop, Task assembly). Augments `MatbotServices` with `WebPrincipalResolver`.
- `src/a2a-card.ts` — `agentCard`: pure, dependency-free builder for the well-known card document (unit-testable).
- `src/a2a-card.test.ts` — tests for the card builder.

## Schema

None of its own (turns persist through the standard eidan session/store path).

## Config

- `MATBOT_A2A_PORT` — listen port (default `8095`).
- `EIDAN_A2A_PROVIDER` (falls back to `EIDAN_JOB_PROVIDER`, then `claude`) — LLM provider used to run the turn.
- `EIDAN_A2A_NAME` — agent name in the card (default `eidan`).
- `EIDAN_A2A_URL` — the card's advertised endpoint (default `http://localhost:<port>/a2a`).
