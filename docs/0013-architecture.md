<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0013 — Architecture overview

Status: **Reference** — the map of how the pieces fit. Source under `packages/` is authoritative.

## The shape

eidan is **plugins on the matbot runtime**. `external/matbot` (a vendored Apache-2.0 submodule) is a
thin isomorphic-TypeScript agent engine — the turn loop, providers, tools, hooks, sessions, the
service registry. eidan adds the **product layer**: relational Postgres memory, auth, the interop
surfaces, jobs/routines, the secrets vault, and the deploy story. There is no build step — Node 24+
runs the `.ts` directly (native type-strip).

```
external/matbot/   the engine (don't edit; contribute upstream — see docs/0014 vendoring note)
packages/<name>/   eidan plugins (AGPL); one TS module each, `export const plugin`
apps/web/          the Next.js front door (chat + Next→Postgres dashboards)
migrations/        the eidan.* schema (ordered SQL + a node runner)
infra/fly-mb/      the deployable host image
```

## Plugins & the service registry

A plugin extends the host through matbot's seams: **tools**, **hooks**, a **StorageBackend**,
**providers**, **frontends**, and the **service registry**. Cross-plugin collaboration is by
interface name: `await services.register('EidanMemory', impl)` then `services.EidanMemory?.…`. eidan
registers `StorageBackend`, `EidanMemory`, `JobHandlers`, `WebPrincipalResolver`, `Notify`,
`LlmCalls`, `Vault`/`EidanSecrets`, `PanelProxy`, `Routines`, `TelegramChats`.

## Data: Postgres is the source of truth

Everything lives under the `eidan` schema (conversations, messages, knowledge, notes, jobs, routines,
secrets_vault, kv, telegram_chats, …). Persistence is **keen** — the inbound message hits the store
before the provider call; messages are append-only. Tenant isolation is **ambient-principal RLS**:
each call stamps `eidan.current_user_id` so a non-superuser app role only sees its own rows.

## The layers

| Layer | Plugins / docs |
|---|---|
| **Storage & memory** | `storage-postgres` (matbot StorageBackend over `eidan.*`, plus `eidan.kv`), `memory` ([[0011-memory]]) |
| **Surfaces (in)** | `frontend-agui` (chat + the `PanelProxy` front door, [[0012-frontend-agui]]), `frontend-telegram` ([[0002-telegram-frontend]]), `mcp-server` + `a2a-server` ([[0014-interop]]); `apps/web` is the Next.js UI ([[0003-pwa-installable-web-app]], [[0004-model-picker]], [[0007-admin-panels]]) |
| **Surfaces (out)** | `notify` (topic→channel), `TelegramChats` |
| **Background work** | `jobs` ([[0010-jobs]]), `routines` ([[0005-routines]]) |
| **Secrets & auth** | `vault-postgres` + `secrets-api` ([[0009-secrets-vault]]), `auth` (JWT `WebPrincipalResolver`) |
| **Cost & sandbox** | `llm-calls` (per-call ledger), `procedures` (isolated-vm) |

## Open core, all AGPL

Everything is AGPL — core and every plugin, including the mail / calendar / Gmail / Drive
integrations. New capabilities drop in as more matbot plugins via the same service registry, never
editing core (see the gitignored-config policy in `CLAUDE.md`). A plugin can live here or in its own
AGPL repo and be vendored into the deploy image; the admin UI stays plugin-agnostic by convention
([[0007-admin-panels]]).

## Deploy

The `infra/fly-mb` image (or a node process under systemd) runs the engine; `apps/web` deploys
separately (Vercel); Postgres is shared as the source of truth. One node or many sharing one DB —
cross-node work is coordinated through the database (job claims `FOR UPDATE SKIP LOCKED`, routine
`fired_for` uniqueness, the Telegram single-poller config). Tests run via `node:test` through the
matbot loader, gated in CI ([[0008-testing]]).
