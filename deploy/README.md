<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# eidan-deploy — one CLI, every target, with bundles

`eidan-deploy` assembles your **bundles** into the build and ships eidan to any **target**. One
config, `eidan.deploy.json` (gitignored — copy `eidan.deploy.example.json`).

```bash
node deploy/eidan-deploy.mjs deploy local     # docker compose on this box
node deploy/eidan-deploy.mjs deploy fly        # Fly.io
node deploy/eidan-deploy.mjs deploy kesha      # a Raspberry Pi over ssh (arm64)
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
4. **migrate** — `eidan-deploy migrate <target>` applies the `eidan.*` schema to that target's DB.

## Config (`eidan.deploy.json`)

```json
{
  "bundles": [{ "name": "sage", "path": "../eidan-sage/packages/sage", "kind": "code" }],
  "targets": {
    "local": { "type": "compose" },
    "fly":   { "type": "fly", "app": "your-eidan", "config": "fly.toml" },
    "kesha": { "type": "compose-ssh", "host": "192.168.1.100", "user": "pi",
               "registry": "ghcr.io/sielay", "platform": "linux/arm64" }
  }
}
```

A bundle is either a local `path` or a `git` ref (`owner/repo#branch`, optional `subdir`). Bundles
plug in purely through the string-keyed service registry, so adding one never edits core.

## No bundles? Just use compose directly

If you don't need bundles, skip the CLI: `cp .env.compose.example .env && docker compose up -d`.
