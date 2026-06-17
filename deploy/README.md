<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# eidan-deploy — one CLI, every target, with bundles

`eidan-deploy` assembles your **bundles** into the build and ships eidan to any **target**. One
config, `eidan.deploy.json` (gitignored — copy `eidan.deploy.example.json`).

```bash
node deploy/eidan-deploy.mjs deploy local     # docker compose on this box
node deploy/eidan-deploy.mjs deploy fly        # Fly.io
node deploy/eidan-deploy.mjs deploy kesha      # a Raspberry Pi as a node process under systemd (ssh-node)
```

## The interactive wizard (the front door)

Most operators never touch a flag or a YAML file — run the menu:

```bash
pnpm eidan                       # or: node deploy/eidan-cli.mjs
pnpm link --global && eidan      # global `eidan` command, pre-publish (future: npx @eidandev/eidan)
```

A **@clack/prompts** wizard (arrow-key menus, multiselect, colour) with a hero showing the version +
git HEAD freshness. **On a fresh project** (no manifest / unfilled `.env`) it detects that and walks
you through first-run setup — scaffolds config + secrets, prompts the essentials (DB connection,
login email, Anthropic key, public URL — secrets masked), and offers to run migrations — before
dropping you in the menu. Flows: `init` / add a target / add a bundle / configure a target / add keys /
`doctor` / `compile` / plan / push / `migrate` / `deploy` / seal — secrets are edited in your
`$EDITOR`, never echoed. The verbs (`eidan-deploy.mjs <verb>`) remain the scriptable, zero-dep,
install-free engine for CI. *Roadmap (seams in place, not yet built): `provision` a bare box
(Pi/Ryzen), browser **deeplink auth** for keys, `db backup`/`restore`/`import`, models-via-API.*

## Config & env: the model (read this first)

eidan config comes in **two tiers**:

- **Tier 1 — files (bootstrap).** Everything needed to start and connect *before* the DB/vault are
  usable: `DATABASE_URL`, the vault KEK, JWT secret, provider keys, node identity, ports, models,
  flags. Lives in **`.env`** (engine: fly + kesha) and **`apps/web/.env`** (web: Vercel).
- **Tier 2 — DB/runtime (per-user, mutable).** Each user's third-party creds (encrypted in
  `eidan.secrets_vault` by the KEK), settings, knowledge. Set via the **UI**, never in files.

You only hand-edit Tier 1. There is **one catalog** for it — [`deploy/env-schema.mjs`](env-schema.mjs)
— listing every key with: required/optional, secret?, how to generate, description, and **which
targets** get it (by role: `engine` = fly+kesha, `worker` = kesha, `web` = vercel). Values live in
the `.env` files; **routing lives in the schema**; `eidan.deploy.json` only adds node connection
details + non-secret per-node literals (`env_set`).

### The DX flow
```bash
node deploy/eidan-deploy.mjs init          # scaffold .env + apps/web/.env: auto-gen secrets, defaults, ‹FILL› markers
#   ... paste the few externals (DB URL, API keys, PAT) into the ‹FILL› spots ...
node deploy/eidan-deploy.mjs doctor        # validate: required present, no placeholders, auth keys match engine<->web
node deploy/eidan-deploy.mjs env-plan kesha   # what routes to a target + what its file is missing (names only)
node deploy/eidan-deploy.mjs compile kesha    # render the target's matbot.yaml (plugins+providers) + env from the manifest
node deploy/eidan-deploy.mjs env-push kesha --yes   # apply .env -> the node (fly secrets / Pi env file / vercel)
node deploy/eidan-deploy.mjs secrets seal  # encrypt .env -> committable .env.enc
node deploy/eidan-deploy.mjs env-example   # (maintainers) regenerate the .env.example files from the schema
```

### Targets (where values land)
| Target | Role | File | Push mechanism |
|---|---|---|---|
| `fly` | engine | `.env` | `fly secrets import` |
| `kesha` | engine + worker | `.env` → `/etc/eidan/eidan.env` | rsync render + restart |
| `vercel` | web | `apps/web/.env` | Vercel dashboard / `vercel env` (no auto-push) |

Shared keys are **identical-by-name** across engine and web now (`EIDAN_AUTH_*`, `EIDAN_WEB_URL`,
`EIDAN_SMTP_PASSWORD`) — the old web-only aliases (`EIDAN_SMTP_PASS`, `EIDAN_PUBLIC_ORIGIN`,
`EIDAN_PUBLIC_URL`) were renamed to match the engine. The **auth trio** (`EIDAN_AUTH_MASTER_KEY`,
`EIDAN_AUTH_JWT_SECRET`, `EIDAN_AUTH_ALLOWED_EMAIL`) must hold the **same value** on both — `doctor`
checks this. One name is intentionally **kept distinct**: the web reads `EIDAN_DATABASE_URL` (a
separate, restricted `eidan_app` role), *not* the engine's privileged `DATABASE_URL` — aliasing them
would risk giving the web superuser DB access.

### Where values come from — pluggable `SecretSource`
The schema/routing/doctor/push glue is **source-agnostic**; only [`deploy/secret-source.mjs`](secret-source.mjs)
knows how to *fetch* values. Choose the source in `eidan.deploy.json` (default keeps OSS zero-dep):

```jsonc
"secrets": { "source": "dotenv" }   // default — reads .env / apps/web/.env
"secrets": { "source": "sops" }     // encrypted files via `sops -d` (age / AWS-KMS / GCP-KMS / Vault keys)
"secrets": {                         // the UNIVERSAL adapter for any secret server:
  "source": "exec",                  //   give it a command per file that prints KEY=value or JSON
  "command": {
    "root": "doppler secrets download --no-file --format env",
    "web":  "infisical export --env=prod --path=/web"
  }
}
```

`exec` covers **Delinea, HashiCorp Vault, Doppler, Infisical, AWS/GCP Secret Manager, 1Password**, … by
pointing at the operator's own CLI — no bespoke adapter per server. We don't reinvent a secret *server*
(use SOPS or one of those); we keep the thin eidan glue (two-tier model + matbot topology routing +
heterogeneous push to Pi/Fly/Vercel) and let the value source plug in. `init` / `secrets seal` /
`env-pull` are dotenv-mode authoring helpers; with `sops`/`exec` the operator manages values in that
backend and the rest (`doctor`, `env-plan`, `env-push`) just works.

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

- **The box keeps its own config by default.** `matbot.yaml` and `.env` are **not** synced — they
  live on the box and decide which plugins/secrets load. rsync has **no `--delete`**, so it never
  removes box-local files. (So bundles you want on the box go in *its* `matbot.yaml`; this is
  why the same assemble step still runs first.)
- **No git, no registry on the box** — just the rsynced sources + `pnpm install`.
- **Passwordless `sudo systemctl restart <service>`** must work for the deploy user.
- **`--dry-run`** previews the file transfer and skips the install + restart:
  `node deploy/eidan-deploy.mjs deploy kesha --dry-run`.

## Config drift — `check` and `--sync-config`

Because the box keeps its own `matbot.yaml`, its plugin list can silently **drift** from the
assembled config: a bundle gets rsynced to the box but never loads because nobody hand-edited the
box's yaml. Two tools close that gap:

```bash
node deploy/eidan-deploy.mjs check kesha               # read-only: report drift, never change anything
node deploy/eidan-deploy.mjs deploy kesha --sync-config # also render + push the box's matbot.yaml
```

- **`check <target>`** (read-only) compares the plugins the assembled config *intends* for the box
  (the assembled set minus the target's `disable`) against what the box's `matbot.yaml` actually
  loads, and reports **missing** (intended but not loaded — the silent-drift bug) and **extra**
  (loaded but no longer intended). With `env_files` + `env_keys` declared on the target it also
  reports missing env **key names** (never values). Exit `0` clean / `1` drift / `2` box unreachable
  — so it can gate a deploy or run in CI.
- **`deploy … --sync-config`** (opt-in; default off) renders the box's `matbot.yaml` from the
  assembled config minus `disable`, **backs up** the box's current file to `matbot.yaml.bak-predeploy`,
  and pushes the rendered one — so the box can't drift. Off by default preserves any box-local hand
  tuning; turn it on once the box's yaml should be fully config-driven.

Nodes differ by **role**, so each ssh-node target may declare a `disable` list (plugins to strip for
that box) and, optionally, `env_files` + `env_keys` for env-key drift:

```json
"kesha": {
  "type": "ssh-node", "host": "192.168.1.100", "user": "pi",
  "dir": "eidan-mb", "service": "eidan-mb.service",
  "disable": [],
  "env_files": ["/etc/eidan/eidan.env", "/etc/eidan/matbot.env"],
  "env_keys": ["EIDAN_DATABASE_URL", "EIDAN_AUTH_MASTER_KEY", "EIDAN_JOB_KINDS", "ANTHROPIC_API_KEY"]
}
```
(`env_files` must be readable by the deploy user — names only are read, never values.)

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

## Secrets at rest (`secrets seal` / `open`)

The canonical secret set is the gitignored `.env` — which "exists only in that one checkout". To
track it durably without plaintext in git (the matbot-era replacement for the old ansible-vault
plan), seal it into a committable encrypted blob:

```bash
echo "<long-random-passphrase>" > .vault-pass && chmod 0600 .vault-pass   # one-time
node deploy/eidan-deploy.mjs secrets seal      # .env -> .env.enc  (commit .env.enc)
node deploy/eidan-deploy.mjs secrets open      # .env.enc -> .env  (fresh checkout; --force to overwrite)
node deploy/eidan-deploy.mjs secrets status    # is .env.enc in sync with .env?
node deploy/eidan-deploy.mjs secrets selftest  # round-trip check on throwaway data
```

- `.env.enc` is AES-256-CBC + PBKDF2 (200k iters) — **committable to the private canary repo**.
- `.vault-pass` (or `$EIDAN_VAULT_PASS`) holds the passphrase — **never committed** (gitignored, must
  be `0600`); the passphrase is never passed on a command line or printed.
- This is durable backup/tracking only; it does **not** change how a running node reads secrets (Fly
  uses `fly secrets`; an ssh-node reads its own env file). Re-seal after editing `.env`.

## No bundles? Just use compose directly

If you don't need bundles, skip the CLI: `cp .env.compose.example .env && docker compose up -d`.
