<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Deploying the eidan core (matbot host image)

One image runs the full eidan core plugin set on the matbot CLI. Node 24 runs the TypeScript
sources directly (no build step). The same image deploys to every node; per-node **env** tunes the
role (an API node exposes the HTTP servers; a worker node just runs the jobs loop).

## Build & run

```bash
# from the repo root (build context = repo root; .dockerignore keeps it lean)
docker build -f infra/fly-mb/Dockerfile -t eidan-core .
docker run --env-file .env -p 8090:8090 -p 8091:8091 -p 8095:8095 eidan-core
```

## Required env (secrets via the deploy vault, never committed)

| var | used by | notes |
|-----|---------|-------|
| `EIDAN_DATABASE_URL` | storage-postgres, jobs, llm-calls | Postgres URL; node-pg form (`?sslmode=no-verify` for the Supabase pooler) |
| `ANTHROPIC_API_KEY` | provider | `${...}` in matbot.yaml |
| `EIDAN_AUTH_JWT_SECRET` | auth | shared HS256 secret the Next app signs with |
| `MATBOT_PRINCIPAL` | host | boot identity — a real `eidan.users` UUID (a non-UUID FK-fails) |
| `EIDAN_JOB_KINDS` | jobs | comma list the worker claims (`chat`; add `code` etc. when a bundle is present) |
| `MATBOT_AGUI_PORT` / `MATBOT_MCP_PORT` / `MATBOT_A2A_PORT` | servers | default 8090 / 8091 / 8095 |
| `EIDAN_NOTIFY_ROUTES` | notify | optional JSON `{topic:{channel,target}}`; dry-run if unset |

## Ports

- **8090** — AG-UI turn stream + conversation REST (the Next app's backend)
- **8091** — inbound MCP (JSON-RPC)
- **8095** — inbound A2A (agent card + message/send)

## Schema (deploy + update)

Apply migrations before/after a deploy that changes schema:

```bash
EIDAN_DATABASE_URL=… pnpm --filter @eidandev/migrate migrate   # idempotent; tracks eidan._migrations
```

`migrations/sql/0001_baseline.sql` is the full schema snapshot; later changes are new numbered
`.sql` files. **Update flow** = rebuild the image, redeploy, run `migrate`.

## Paid bundles (pro / sage / …)

Bundles are **private** and never live in the core repo (`packages/<bundle>/` is gitignored). A
deploy that includes one **vendors** it into `packages/<bundle>/` before `docker build` (the image
copies `packages/`), appends `- ./packages/<bundle>` to its `matbot.yaml`, and adds the bundle's job
kind to `EIDAN_JOB_KINDS`. Until matbot is published to npm, a vendored bundle's
`@matatbread/matbot-plugin-api` dep is rewritten to `link:../../external/matbot/packages/core/plugin-api`
(the host's vendored copy). A bundle plugs in purely through string-keyed services
(`services.JobHandlers.register('code', …)`), so it stays decoupled from the core's package layout.
