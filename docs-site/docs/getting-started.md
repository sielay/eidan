---
id: getting-started
title: Getting started
sidebar_position: 3
---

# Getting started

Two paths to a running eidan: **Docker** (recommended — fastest to a talking agent) or **from
source** (for hacking on the code). Both need a Postgres database eidan can own the `eidan` schema
in.

## Prerequisites

- A **Postgres 13+** database, reached via a **non-superuser** role (so row-level security
  enforces).
- For Docker: Docker + Docker Compose.
- For source: **Node 24+** (the runtime strips TypeScript and runs it directly — no build step)
  and `pnpm`.

## Option A — Docker (recommended)

```bash
git clone https://github.com/sielay/eidan.git
cd eidan
docker compose up -d          # → http://localhost:3001
```

Open **http://localhost:3001** and sign in with the magic link. Update later with
`docker compose pull && docker compose up -d` — your data is the Postgres volume.

{/* TODO(screenshot): the web UI right after first sign-in (localhost:3001). */}

## Option B — the setup wizard

From a clone, the interactive wizard walks you through applying migrations, adding a target,
choosing bundles, configuring, and `doctor`/`migrate` checks:

```bash
pnpm eidan          # interactive wizard
```

## Option C — from source

For hacking on the code (Node 24+ runs the TypeScript directly):

```bash
( cd external/matbot && pnpm install )   # the vendored runtime
pnpm install                             # the eidan plugins
cp matbot.yaml.example ./matbot.yaml     # host config (the real matbot.yaml is gitignored)

# apply the schema (non-superuser role so RLS enforces)
EIDAN_DATABASE_URL=postgres://eidan_app:...@host/eidan \
  pnpm --filter @eidandev/migrate migrate

# start the engine (AG-UI on :8090, MCP on :8091, A2A on :8095)
node --import ./external/matbot/apps/cli/register.js \
  external/matbot/apps/cli/src/index.ts start --config ./matbot.yaml
```

Run the reference web UI against it:

```bash
cd apps/web && pnpm install && pnpm dev    # → http://localhost:3001
# set NEXT_PUBLIC_EIDAN_BACKEND_URL= (empty) and EIDAN_ENGINE_URL to the engine
```

## Next

- **[Concepts](/concepts)** — how memory, plugins, agents, and the vault fit together.
- **[Use cases](/use-cases)** — what to try first.

:::note
Deploying to a server, a Raspberry Pi, or Fly is driven by the deploy CLI (`pnpm eidan`) and a
gitignored `eidan.deploy.json` topology. A dedicated **Deploy** guide is coming; for now the
repo's `README.md` and `infra/fly-mb/` are the authoritative reference.
:::
