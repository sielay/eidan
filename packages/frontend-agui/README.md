# @eidandev/frontend-agui

eidan's **engine-side chat surface** — it exposes the matbot turn stream as
**AG-UI over HTTP + SSE** so the eidan Next.js app can drive conversations.
matbot's own `frontend-web` stays dev/demo only; this is the production front
door. It also serves the plain REST reads the UI needs alongside the stream
(conversation list, message history, plugin catalogue) and acts as the single
public ingress that reverse-proxies other plugins' internal panels.

It registers a frontend (no agent tools). The public port (`:8090`, `MATBOT_AGUI_PORT`)
is the only one exposed.

## Exposes

- **`POST /api/turn`** — runs a turn on `conversation_id` and streams AG-UI
  events as SSE (`RUN_STARTED`, `TEXT_MESSAGE_*`, the `TOOL_CALL_*` quartet,
  `RUN_FINISHED`/`RUN_ERROR`). Honours a per-turn `provider` if configured,
  else the server default. Buffers `usage` events and records them to the
  `LlmCalls` ledger keyed by the committed user message id.
- **REST** (`src/rest.ts`, RLS-scoped reads): `GET/POST /api/conversations`,
  `GET/PATCH /api/conversations/:id`, `GET /api/conversations/:id/messages`,
  `POST /api/conversations/:id/regenerate_title`, `GET /api/commands` (live tool
  registry), `GET /api/plugins[/:name]` (rich plugin catalogue cards).
- **`PanelProxy` service** — other plugins (`@eidandev/secrets-api`, bundle
  panels) register a path prefix + loopback port; this server reverse-proxies
  matching requests to them so their ports stay internal.
- **`/health`** and, in dev only (`EIDAN_DEV_AUTH=1`), an unauthenticated
  `/api/auth/*` shim (magic-link/verify/refresh/logout) that mints HS256 tokens
  `@eidandev/auth` verifies.

## How consumed

The Next app `POST`s to `/api/turn` and renders the AG-UI SSE stream; it reads
conversation/message history over the REST routes. Identity comes from
`@eidandev/auth`'s `WebPrincipalResolver`: each request resolves a `Principal`
and the turn runs under `runAs`. With no resolver it fails closed (`401`) unless
boot-principal fallback is explicitly opted in.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; registers the frontend + `PanelProxy`, starts the server.
- `src/server.ts` — HTTP server, CORS, principal resolution, `/api/turn` stream + usage ledgering.
- `src/agui-emitter.ts` — maps matbot `PipelineEvent`s onto AG-UI event objects.
- `src/rest.ts` — the plain CRUD/read surface + plugin catalogue cards.
- `src/panel-proxy.ts` — the `PanelProxy` registry + reverse-proxy.
- `src/auth-dev.ts` — dev-only `/api/auth/*` shim (gated by `EIDAN_DEV_AUTH`).
- `src/db.ts` — lazy pool + `withPrincipal` (stamps the principal GUC for RLS).

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection for the REST reads (**required**).
- `MATBOT_AGUI_PORT` — public listen port (default `8090`).
- `EIDAN_AGUI_PROVIDER` (falls back to `EIDAN_JOB_PROVIDER`, then `claude`) — default turn provider/model.
- `EIDAN_DEV_AUTH=1` — enable the dev auth shim + boot-principal fallback (never in production).
- `EIDAN_ALLOW_BOOT_PRINCIPAL=1` — allow boot-principal fallback without the dev shim.
