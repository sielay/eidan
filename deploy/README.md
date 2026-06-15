<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# eidan-deploy — one CLI, every target, with bundles

`eidan-deploy` assembles your **bundles** into the build and ships eidan to any **target**. One
config, `eidan.deploy.json` (gitignored — copy `eidan.deploy.example.json`).

```bash
node deploy/eidan-deploy.mjs deploy local     # docker compose on this box
node deploy/eidan-deploy.mjs deploy fly        # Fly.io
node deploy/eidan-deploy.mjs deploy kesha      # a Raspberry Pi as a node process under systemd (ssh-node)
```

## What a deploy does

1. **assemble** — vendor each configured bundle into `packages/<name>/` (private; gitignored),
   point its `@matatbread/matbot-plugin-api` at the host's vendored copy, and fold it into the engine
   host config (`matbot.yaml`) + the worker's job kinds. Idempotent.
2. **build** — build the engine image (`infra/fly-mb/Dockerfile`) + the web image (`apps/web`).
   `--arm` / a target `platform` does a multi-arch `buildx` for Pis.
3. **ship** — per target type:
   - `compose` — `docker compose up -d --build` here.
   - `fly` — `flyctl deploy` (Fly builds the Dockerfile, bundles baked in).
   - `compose-ssh` — `buildx --push` to your registry, then `ssh` the box to `compose pull && up`.
   - `ssh-node` — no Docker: `rsync` the engine runtime to the box and restart its systemd
     service (see below). For a Pi/small box running the engine as a plain node process.
4. **migrate** — `eidan-deploy migrate <target>` applies the `eidan.*` schema to that target's DB.

## `ssh-node` — a node process under systemd (e.g. a Pi)

For a box that runs the engine **directly as a node process** (no Docker), `ssh-node` rsyncs
the assembled runtime and restarts a systemd service:

```
rsync -azR --exclude node_modules --exclude .git \
  packages migrations package.json pnpm-lock.yaml pnpm-workspace.yaml  <user>@<host>:<dir>/
ssh <user>@<host>  "cd <dir> && pnpm install --prefer-offline && sudo systemctl restart <service>"
```

What this means for the box:

- **The box keeps its own config.** `matbot.yaml` and `.env` are **never** synced — they live
  on the box and decide which plugins/secrets load. rsync has **no `--delete`**, so it never
  removes box-local files. (So bundles you want on the box go in *its* `matbot.yaml`; this is
  why the same assemble step still runs first.)
- **No git, no registry on the box** — just the rsynced sources + `pnpm install`.
- **Passwordless `sudo systemctl restart <service>`** must work for the deploy user.
- **`--dry-run`** previews the file transfer and skips the install + restart:
  `node deploy/eidan-deploy.mjs deploy kesha --dry-run`.

One-time box setup: install Node 24+ and pnpm, create `<dir>` (default `eidan-mb`), put a
`matbot.yaml` + `.env` there, and add a systemd unit (default `eidan-mb.service`) whose
`ExecStart` runs the engine from `<dir>`. After a schema change, run
`eidan-deploy migrate <target>` (supply `database_url` on the target or `EIDAN_DATABASE_URL`).

## Config (`eidan.deploy.json`)

```json
{
  "bundles": [{ "name": "sage", "path": "../eidan-sage/packages/sage", "kind": "code" }],
  "targets": {
    "local": { "type": "compose" },
    "fly":   { "type": "fly", "app": "your-eidan", "config": "fly.toml" },
    "kesha": { "type": "ssh-node", "host": "192.168.1.100", "user": "pi",
               "dir": "eidan-mb", "service": "eidan-mb.service" }
  }
}
```

A bundle is either a local `path` or a `git` ref (`owner/repo#branch`, optional `subdir`). Bundles
plug in purely through the string-keyed service registry, so adding one never edits core.

## No bundles? Just use compose directly

If you don't need bundles, skip the CLI: `cp .env.compose.example .env && docker compose up -d`.
