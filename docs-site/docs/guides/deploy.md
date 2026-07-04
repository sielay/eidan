---
id: deploy
title: Deploy
---

# Deploy

eidan is designed so you can run, deploy, and upgrade **without editing a tracked file** — every
operator-private choice lives in an env var, a secret, or a gitignored config path. Pick the shape
that fits.

## Docker Compose (single box)

The simplest production shape — one host, one Postgres volume:

```bash
docker compose up -d              # → http://localhost:3001
docker compose pull && docker compose up -d   # update in place
```

Your data is the Postgres volume; back that up and you can move or restore anywhere.

## The deploy CLI (multi-node / cloud)

For deploying to a server, a Raspberry Pi, or a cloud host, the wizard and CLI drive it from a
gitignored topology (`eidan.deploy.json`) plus your secrets:

```bash
pnpm eidan                        # interactive wizard: add a target, pick bundles, doctor, migrate
```

The topology is a small **3-file model**, all gitignored:

- **`.env`** — the single source for every secret **value** (DB URL, model keys, master key, …).
- **`eidan.deploy.json`** — the topology: which bundles + nodes, and which env **keys** route where
  (no secret values).
- **`matbot.yaml`** — the assembled plugin + provider list for a node.

Ship to a target:

```bash
node deploy/eidan-deploy.mjs deploy <target>   # e.g. a container host, an ssh node, or a web build
```

{/* TODO(screenshot): the deploy CLI / wizard output, or the Admin → Nodes view showing a live node. */}

## After a deploy that changes the schema

Migrations are mandatory when the `eidan.*` schema changes (idempotent + additive):

```bash
EIDAN_DATABASE_URL=… pnpm --filter @eidandev/migrate migrate
```

## Notes

- Run Postgres behind a **non-superuser** role so row-level security enforces.
- Config + secrets resolve from the **vault** where possible, so a vaulted feature reaches every node
  with no per-node env. See the [vault concept](/concepts) and [Configuration](/reference/configuration).
- Scale out by adding nodes that share **one** Postgres — single-owner work (schedules, queues) is
  coordinated through the database.
