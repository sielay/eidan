<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0012 — Chat surface + front-door proxy (frontend-agui)

Status: **Shipped** — `@eidandev/frontend-agui` (the engine's HTTP front door, `:8090`).

## Goal

The engine-side **chat surface** the Next.js app talks to: run a turn on a conversation and stream
the result as AG-UI events. It's also the single **public port** — other plugins' internal HTTP
servers are reverse-proxied behind it, so only one port is exposed.

## The chat API

- **`POST /api/turn`** `{ conversation_id, text, provider? }` → **AG-UI SSE** stream. The handler
  resolves the caller's `Principal` (Bearer JWT via `WebPrincipalResolver`), loads (or creates) the
  session keyed by `conversation_id`, runs the turn (`run.open`) under that principal, and an
  `AguiEmitter` maps matbot pipeline events → AG-UI events (`TEXT_MESSAGE_*`, `TOOL_CALL_*`,
  `RUN_*`).
- **Per-turn provider override.** `body.provider` is honoured **only if it's a real provider** in
  `services.providers` (a `matbot.yaml` `providers:` key); otherwise it falls back to the server
  default. This is what the [model picker](0004-model-picker.md) drives.
- **`POST /api/conversations`** — create a conversation.

## The front-door proxy (`PanelProxy`)

`frontend-agui` registers `PanelProxy` (`services.register('PanelProxy', …)`). Several plugins bind
their own loopback port but shouldn't each open a public port, so they register a path prefix:

```ts
services.PanelProxy?.register({ prefix: '/api/me/secrets', port });
```

The `:8090` dispatcher matches the prefix **before** principal resolution and reverse-proxies the
request (Bearer token intact) to `127.0.0.1:<port>`, so the plugin self-authenticates. Current
users: `secrets-api` (`/api/me/secrets`), `frontend-telegram` (`/api/me/telegram/link`), and the
Google OAuth server. The web app therefore proxies to **one** engine URL and the internal ports stay
private.

## Config

| Env | Default | Meaning |
|---|---|---|
| `MATBOT_AGUI_PORT` | `8090` | the public front-door port. |
| `EIDAN_AGUI_PROVIDER` | → `EIDAN_JOB_PROVIDER` → `claude` | default turn provider. |
| `EIDAN_DEV_WEB_ORIGIN` | — | credentialed-CORS origin for local cross-origin dev. |

Load after `auth` (needs `WebPrincipalResolver`); plugins that register a panel must load after this.

## Files of record

- `packages/frontend-agui/src/server.ts` — the HTTP server, `/api/turn`, AG-UI emit, dispatch.
- `packages/frontend-agui/src/panel-proxy.ts` — `createPanelProxy` (`register` / `match` / `proxyToPanel`).
- `packages/frontend-agui/src/index.ts` — boot + `PanelProxy` registration.
