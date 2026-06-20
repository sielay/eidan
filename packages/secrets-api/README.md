# @eidandev/secrets-api

The **secure, LLM-free secrets write path** — a small authenticated HTTP server
the Settings UI calls to set integration secrets server-side, so a value reaches
`eidan.secrets_vault` **encrypted without ever passing through a model turn**.
This is the counterpart to the value-free `secret` chat tool: the agent can
*request* a secret, but the value is entered in a masked field and POSTed here.

This plugin registers an **HTTP frontend**, not agent tools — so it has no Tools
table. It does the encrypted writes by delegating to the `EidanSecrets` service
from `@eidandev/vault-postgres`; every operation runs under the caller's
`Principal`, resolved from the Bearer token via `WebPrincipalResolver`.

## What it provides

An HTTP API (default port `8092`, via `MATBOT_SECRETS_PORT`) on these routes
under `/api/me/secrets`:

| Method + path | Purpose |
|---|---|
| `GET /api/me/secrets` | metadata — which secret names are set, scope, `updatedAt` (no values). |
| `GET /api/me/secrets/catalog` | the plugin-declared sections/fields the UI renders. |
| `PUT /api/me/secrets/:name` | body `{ "value": "…" }` → seals it into the vault; the response never echoes the value. |
| `DELETE /api/me/secrets/:name` | remove one of the caller's secrets. |

## How others consume it

- The **web Settings UI** POSTs the masked value here, bypassing the LLM.
- `frontend-agui`'s front door reverse-proxies the `/api/me/secrets` prefix to
  this server's port (registered via `services.PanelProxy?.register`), so the
  web app talks to one engine URL and `:8092` stays internal.
- The server itself consumes `services.EidanSecrets` (writes) and
  `services.WebPrincipalResolver` (per-request identity).

Hardening: credentialed CORS only echoes the configured `EIDAN_DEV_WEB_ORIGIN`
(never reflects an arbitrary origin); errors return a generic 500, logged
server-side, to avoid info exposure on a secrets endpoint.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; registers the frontend, starts the
  server, registers the `PanelProxy` route, stops it on teardown.
- `src/server.ts` — the `node:http` server: path parsing, Bearer-resolved
  `runAs(principal, …)`, the GET/PUT/DELETE handlers, CORS + error policy.

## Schema

None of its own. Writes/metadata go through `EidanSecrets`, which is backed by
`eidan.secrets_vault` (owned by `@eidandev/vault-postgres`).

## Config

- `MATBOT_SECRETS_PORT` — listen port (default `8092`).
- `EIDAN_DEV_WEB_ORIGIN` — origin echoed for credentialed CORS (optional;
  needed when the UI calls cross-origin in dev).
- Inherits the vault's `EIDAN_DATABASE_URL` + `EIDAN_AUTH_MASTER_KEY` indirectly
  through the `EidanSecrets` service it consumes.
