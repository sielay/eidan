# Deployment

Eidan ships as a **Python backend** plus a **Next.js frontend** plus
**Postgres** as the shared source of truth. The backend is designed
to run multi-instance (Fly.io regions, a Pi plus a cloud node, etc.)
behind a load balancer or as independent peers — Postgres holds
state, and work that needs a single owner (cron, leases, the
sequencer in [AGENTIC LOOP](./005_AGENTIC_LOOP.md)) elects a leader
rather than assuming one process. Single-instance is a valid
deployment, not a design assumption.

This document is a **menu of recipes**: pick the topology that
matches what you already have (or want), and follow that recipe
end-to-end. Cross-cutting reference material (auth env vars,
database options, the Vercel frontend setup) lives in §6–§8 and is
linked from every recipe so the recipe stays focused on platform
specifics.

> **Just want to set up a new deployment?** Start with `eidan init
> <name>`, which scaffolds a private ops repo with a starter
> `topology.yml`, a `.gitignore` that excludes the vault password
> file, and a README walking through first-time setup. From there
> `eidan deploy --node <name>` reconciles each node against the
> topology, so the per-target recipes below (§3 Pi, §4 Fly) become
> implementation detail behind the CLI rather than steps an
> operator types by hand. Reconcilers are still landing — until
> the target you want is wired up, follow the matching recipe
> below directly.

## 1. The pieces

| Component                | What it is                                           | State                        |
|--------------------------|-------------------------------------------------------|------------------------------|
| **Backend** (`apps/backend`) | Python / FastAPI. Owns the agentic loop, MCP server / client, providers, persistence. | Stateless per process; reads / writes Postgres. |
| **Frontend** (`apps/web`)  | Next.js (App Router). Renders chat UI, dashboards, plugin frontends. | Stateless; calls backend over HTTP / WS. |
| **Database**             | Postgres 13+ with the `eidan` schema.                 | Single shared instance per deployment. |
| **Auth**                 | Native — host mints + verifies RS256 JWTs against a keypair stored encrypted in Postgres. | Internal. No third-party identity provider. |
| **LLM provider**         | Anthropic / OpenAI / Ollama (configurable per node).  | Stateless; each node picks its own provider. |

A core design point: **each node picks its own LLM provider**. A Pi
at home can run `EIDAN_PROVIDER=ollama` for everything (cheap,
private, slow); a Fly machine can run `EIDAN_PROVIDER=anthropic`
for the foreground agent; the Sentry plugin pins its own
`EIDAN_SENTRY_MODEL` independently so background ticks stay cheap
even on an Anthropic-default node. Postgres is the shared
coordination point; provider choice is local.

## 2. Pick a recipe

| Recipe                     | Backend host    | Postgres host    | Frontend host | LLM provider on backend | When it fits                                            |
|----------------------------|-----------------|------------------|---------------|--------------------------|---------------------------------------------------------|
| **§3 Raspberry Pi**        | Pi (`systemd`)  | Pi-local or Supabase | Vercel    | Ollama (local, free)     | Self-host from your own hardware. Cheap, private, slow. |
| **§4 Fly.io**              | Fly machines    | Fly Postgres / Neon | Vercel or Fly | Anthropic / OpenAI       | "Click to deploy" cloud, global reach, zero ops.        |
| **§5 Distributed (reference)** | Fly API + Pi worker | Supabase     | Vercel        | Anthropic on Fly + Ollama on Pi | Latency-sensitive HTTP + always-on Pi workload.   |

Heroku works too (vanilla web dyno + Heroku Postgres) but the
trade-offs aren't materially different from Fly — pick Fly unless
you already live on Heroku.

---

## 3. Recipe: Raspberry Pi (self-hosted, single-host)

The reference "self-hosted on my own hardware" deployment. Pi runs
the API + behaviour dispatcher + Ollama for local inference;
Postgres lives either on the Pi or on Supabase; the Next.js UI
lives on Vercel.

Estimated monthly cost: ~£0 in software + ~£1–3 in electricity +
Pi sunk cost. Adding Vercel hobby (free) and a domain (~£10/year)
keeps the all-in under £5/month.

> **Prefer infrastructure-as-code?** §3.1–3.7 is the explicit
> hand-by-hand recipe — useful the first time and as a reference
> for what's actually happening on the box. Once bootstrapped, the
> steady-state half (env-file edits, bundle install, service
> restarts) lives behind `eidan deploy --node <name>` — see
> [§3.13](#313-reconciling-with-eidan-deploy-recommended).

### 3.0 Prerequisites

- Raspberry Pi 4 or 5 with **4GB+ RAM**, **Debian Bookworm 64-bit**
  (Raspberry Pi OS Lite recommended), reachable over SSH.
- A domain you control (e.g. `eidan.yourdomain.com`) if you plan to
  use the Vercel frontend with a custom domain. Optional if you'll
  only hit the API directly.
- Optional: SMTP credentials (Fastmail, Postmark, Mailgun, …) so
  magic-link emails actually leave the box. Without them the link
  is still logged to journald and you can copy it by hand.
- A checked-out clone of this repo on your laptop (for the
  migration step in §3.5).

### 3.1 Create the service user + deploy dirs

Do this **first** — every subsequent step assumes the `eidan`
service user exists and owns `/opt/eidan`.

```bash
sudo useradd -r -s /bin/bash -d /home/eidan -m eidan
sudo mkdir -p /opt/eidan /etc/eidan
sudo chown eidan:eidan /opt/eidan
```

### 3.2 Install system deps + uv

```bash
sudo apt update && sudo apt install -y git curl
sudo -u eidan bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'
sudo -u eidan /home/eidan/.local/bin/uv python install 3.12
```

Raspberry Pi OS / Debian Bookworm ships Python 3.11 and does
**not** carry `python3.12` in its default apt repos. eidan only
requires `>=3.11`, but letting `uv` manage the interpreter avoids
version drift across Pi vs. Fly (the Fly Dockerfile in §4 targets
3.12). `uv sync` in §3.5 picks up the managed 3.12 automatically.

### 3.3 Install Ollama + pull the sentry model

The Pi's own LLM. Ollama's installer creates an `ollama` system
user, drops a `systemd` unit, and exposes the OpenAI-compatible
endpoint on `http://127.0.0.1:11434/v1`.

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
ollama pull phi3
```

Smoke-check:

```bash
curl http://127.0.0.1:11434/api/tags          # should list phi3
ollama run phi3 "say hi in one word"           # ad-hoc test
```

Notes:

- The default `OLLAMA_HOST=127.0.0.1` is correct — the Pi exposes
  Ollama only to localhost, not the LAN.
- `phi3` (3.8B Q4) fits comfortably in 4GB RAM and is the default
  sentry model (`EIDAN_SENTRY_MODEL=phi3` in `plugins/sentry/plugin.yaml`).
  Swap for a heavier model (`ollama pull mistral`, `ollama pull
  llama3.1:8b`) only if you have 8GB+ headroom.
- Ollama auto-starts on boot via `systemctl enable --now`; the
  eidan-backend unit in §3.7 declares `After=ollama.service` so the
  daemon is up before eidan tries to call it.

### 3.4 Postgres

Pick one. Local Postgres is simpler and keeps everything on the
Pi; Supabase is recommended once you want off-box backups and a UI
for inspection.

**Option A — Postgres on the Pi:**

```bash
sudo apt install -y postgresql
sudo -u postgres psql <<'SQL'
  CREATE ROLE eidan_app LOGIN PASSWORD 'CHANGE-ME-STRONG';
  CREATE DATABASE eidan OWNER eidan_app;
SQL
```

The corresponding `database_url:` in `topology.yml` will be:
`postgresql+asyncpg://eidan_app:CHANGE-ME-STRONG@127.0.0.1:5432/eidan`

Back this up religiously (e.g. nightly `pg_dump | rclone` to
external storage). The Pi is a single point of failure for both
compute *and* data in this shape.

**Option B — Supabase Postgres:**

1. Supabase dashboard → **New project**. Pick a region near you.
   Record the DB password.
2. **Settings → Database → Connection string → URI (direct, port
   5432, NOT the pooler)**. Copy it.
3. `DATABASE_URL` will be:
   `postgresql+asyncpg://postgres:<dbpw>@<host>:5432/postgres`.
   You can swap to a dedicated `eidan_app` role later via
   `EIDAN_CREATE_APP_ROLE=true` on the first migration run (see
   §3.5).

### 3.5 Clone + sync the repo, run migrations

From the Pi (so the venv is built as `eidan` with `eidan`'s `uv`):

```bash
sudo -u eidan git clone https://github.com/sielay/eidan.git /opt/eidan
sudo -u eidan git -C /opt/eidan checkout v0.1.0   # pin to a tag, not main
sudo -u eidan /home/eidan/.local/bin/uv --directory /opt/eidan sync --no-dev
```

Generate the auth master key — **record it offline**, you'll set
the same value on every backend host that joins this deployment
(see §6 for why):

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

> **Joining an existing deployment?** If another node (a laptop
> bootstrap, a Fly machine, an earlier Pi) has already applied
> migrations against this Postgres, **skip the migration step
> below.** Alembic is version-tracked in `eidan.alembic_version`
> and a re-run is a no-op, but skipping avoids the
> `EIDAN_CREATE_APP_ROLE` env handling and the cognitive load of
> wondering whether it did something. Verify with the
> `psql` / Supabase Studio check at the end of this section.

Run migrations (one-shot, against the DB you picked in §3.4).
This invokes `eidan admin db migrate`, which runs core migrations
under `migrations/alembic.ini` first and then iterates each
installed plugin's private-schema migrations
(`plugin_sentry`, …) in topological order — bare `alembic` would
only do core and leave `plugin_sentry.sentry_ticks` etc. missing:

```bash
sudo -u eidan bash -lc '
  DATABASE_URL="postgresql+asyncpg://eidan_app:CHANGE-ME@127.0.0.1:5432/eidan" \
  EIDAN_AUTH_MASTER_KEY="<the-key-you-just-generated>" \
  /home/eidan/.local/bin/uv --directory /opt/eidan run \
    eidan admin db migrate
'
```

For Supabase + a dedicated app role, prepend
`EIDAN_CREATE_APP_ROLE=true EIDAN_APP_DB_PASSWORD="<strong>"` to
the migration command; the role provisioning is idempotent
(`CREATE` on first run, `ALTER` thereafter), so re-running with a
new password rotates it.

Verify in `psql` (or Supabase Studio) that `eidan.conversations`,
`eidan.messages`, `eidan.auth_keypair`, and `plugin_sentry.sentry_ticks`
exist. The `eidan.auth_keypair` row is minted lazily on first
backend boot (not at migration time), so it'll be empty until
§3.8.

### 3.6 Env file + systemd unit (rendered by `eidan deploy`)

`/etc/eidan/eidan.env` and `/etc/systemd/system/eidan-backend.service`
are both rendered by `eidan deploy --tags env` from your operator-
private `topology.yml`. Run `eidan init` once on your laptop to
scaffold the topology, fill in the node's fields (database_url,
auth_master_key, auth_allowed_email, provider, …), and the first
deploy lays them down. See [§3.13](#313-reconciling-with-eidan-deploy-recommended)
for the workflow.

You don't write either file by hand. The full field reference lives
in `packages/schemas/schemas/core/deploy/Topology.schema.json`.

### 3.7 Pi-specific journald tweak

Raspberry Pi OS pins journald to RAM-only storage by default
(`/usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf`) to
spare the SD card. With that default in place, `journalctl -u
eidan-backend` shows nothing from before the most recent boot —
including the minutes leading up to whatever made you reboot in the
first place. Override it once on the Pi:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/persistent.conf >/dev/null <<'EOF'
[Journal]
Storage=persistent
EOF
sudo systemctl restart systemd-journald
sudo journalctl --flush
```

Verify the per-machine-id directory was created and the journal is
now living on disk:

```bash
ls /var/log/journal/$(cat /etc/machine-id)/   # non-empty
sudo journalctl --list-boots                  # will grow across reboots
```

Capped by journald's default `SystemMaxUse=200M`. SD-card wear is
not a concern at that volume on modern cards — set
`SystemMaxUse=` in the same dropin if you want a tighter cap.

### 3.8 Smoke-check

Watch journald for these markers on first boot:

- `[bootstrap] behaviour dispatcher started with N cron job(s)` —
  Sentry's tick schedule registered. If you're running multi-node,
  whichever instance grabbed the Postgres advisory lock will print
  this; the others print "another instance owns the dispatcher
  lock" and stand by.
- `[provider] ollama @ http://127.0.0.1:11434/v1 default_model=phi3` —
  the host wired itself to Ollama.

From the laptop, against the Pi:

```bash
curl http://<pi-host>:8000/api/auth/config
# Expect {"provider":"native", ...}

sudo -u eidan -E bash -lc '
  set -a; source /etc/eidan/eidan.env; set +a
  /home/eidan/.local/bin/uv --directory /opt/eidan run eidan admin doctor
'
# Reports DB connectivity, master key set, migrations at head.
```

### 3.9 Frontend (optional, via Vercel)

If you want a web UI, follow §8. The Vercel project's
`NEXT_PUBLIC_EIDAN_BACKEND_URL` points at however the Pi is
reachable — directly via a public DNS record + reverse proxy, or
indirectly via Tailscale / Cloudflare Tunnel / WireGuard.

### 3.10 Sentry status (Phase 1: deterministic only)

Sentry is a `tier: core` plugin and is enabled by default
(`EIDAN_SENTRY_ENABLED=1`). **Important caveat: Phase 1 ships
deterministic detectors only** — overdue commitments, long-silence
gaps, scope-drift checks. Three hand-coded SQL/threshold checks
run on the `PT5M` schedule and write:

- one summary row per tick to `plugin_sentry.sentry_ticks`,
- one row per detected pattern to `plugin_sentry.sentry_nudges`
  (the user-visible nudge),
- one row to `eidan.escalations` (core schema, surfaced in the
  inbox) when a pattern crosses the escalation threshold or a
  nudge delivery fails.

**No LLM call yet.**

The Phi-3 / Ollama open-ended pattern matcher described in
[SENTRY_FEATURE_SPEC.md](./SENTRY_FEATURE_SPEC.md) lands with the
local-model adapter — see the stubs in
`plugins/sentry/eidan_sentry/plugin.py` and `patterns.py`. Until
then, `EIDAN_SENTRY_MODEL=phi3` is a configured-but-unused slot:
the env var exists so the wiring lands cleanly when the adapter
ships, but **setting it today does not make Sentry call phi3.**

Concretely on this Pi:

- The foreground agent (your CLI / chat turns) **does** call phi3
  via Ollama — that's `EIDAN_PROVIDER=ollama` +
  `EIDAN_DEFAULT_MODEL=phi3`.
- The Sentry tick runs the three deterministic detectors and does
  **not** call phi3 (or any LLM) today.

Confirm the tick is firing:

```bash
journalctl -u eidan-backend | grep sentry
```

To pause it (e.g. during noisy testing): `EIDAN_SENTRY_ENABLED=0`
in `eidan.env`, then `sudo systemctl restart eidan-backend`.

### 3.11 Paid bundles (via `eidan deploy --tags plugins`)

Add the bundle names to `nodes.<name>.bundles` in `topology.yml`,
then:

```bash
eidan deploy --node <name> --tags plugins
```

`eidan deploy` writes the plugin tree + lock to `/var/lib/eidan/plugins/`
on the Pi via the bundled Ansible playbook. Restart of the
`eidan-backend` service is triggered automatically when bundles
change. The GitHub PAT comes from `topology.yml`'s
`github_token:` (vault-encrypt it) and is exported to the Pi only
for the duration of the install command.

### 3.12 Updating

```bash
sudo -u eidan git -C /opt/eidan fetch --tags
sudo -u eidan git -C /opt/eidan checkout v0.1.1
sudo -u eidan /home/eidan/.local/bin/uv --directory /opt/eidan sync --no-dev
sudo -u eidan bash -lc '
  set -a; source /etc/eidan/eidan.env; set +a
  /home/eidan/.local/bin/uv --directory /opt/eidan run eidan admin db migrate
'
sudo systemctl restart eidan-backend
```

**Migration ordering.** Most eidan migrations are *additive* (new
tables, new columns, new indexes) — the running service ignores
objects it doesn't know about. The recipe above migrates first,
then restarts. For a *destructive* migration (drop column, rename
table, changed CHECK constraint) stop the service first:

```bash
sudo systemctl stop eidan-backend
# ... pull + sync + migrate ...
sudo systemctl start eidan-backend
```

Release notes flag which migrations are destructive; assume
additive when not stated.

**Bundle updates** go through `eidan deploy --tags plugins` after
bumping the topology — same flow as initial install.

### 3.13 Reconciling with `eidan deploy` (recommended)

Once your operator-private ops repo is scaffolded (`eidan init <name>`
— see the callout at the top of this document) and `topology.yml`
declares your Pi node, day-to-day reconciliation is:

```bash
eidan deploy --node kasha          # one node
eidan deploy                       # every node in the topology
eidan deploy --node kasha --tags env,plugins
eidan deploy --node kasha --dry-run
eidan deploy --node kasha --ask-vault-pass    # decrypts vaulted secrets
```

The CLI loads `topology.yml`, renders an Ansible inventory + vars
file into `.eidan-runtime/<node>/`, and runs the bundled playbook at
`apps/cli/eidan_cli/playbooks/pi/playbook.yml` against them. Runtime
files persist after the run so a failure leaves something to
inspect; the next deploy overwrites them.

The playbook supports `--tags env|plugins|restart` for partial
reconciles; `--dry-run` propagates as `ansible-playbook --check
--diff`. The `bootstrap` tag is reserved as a stub — the one-time
setup (§3.1–3.7) is still by hand.

#### Running the playbook directly (no CLI)

If you'd rather skip the CLI (e.g. invoking from another orchestrator),
the playbook lives at `apps/cli/eidan_cli/playbooks/pi/playbook.yml`
and accepts the variable surface documented at the top of that file.
Render your own inventory + vars and:

```bash
ansible-playbook -i <inventory> -e @<vars.yml> \
  apps/cli/eidan_cli/playbooks/pi/playbook.yml
```

The bundled playbook is the single source of truth — the same file
the CLI invokes.

The playbook is idempotent on bundle name: adding to `eidan_bundles`
installs new ones, removing from the list does **not** uninstall.
Version bumps and removals still go through the hand-edit-the-lock
+ `eidan admin plugin sync --prune` flow in [§3.12](#312-updating) —
this is intentional; modelling "the lock file is desired state"
inside ansible duplicates what the `sync` CLI already does.

The playbook restarts `eidan-backend` via a handler whenever the
env file or the unit file changes, and whenever a bundle is newly
installed. No restart fires if nothing changed.

---

## 4. Recipe: Fly.io (cloud, all-Fly)

The reference "cloud-only" deployment. Fly machine serves the API,
Fly Postgres holds state, Vercel serves the frontend. Auto-scales
to zero on idle.

Estimated monthly cost: Fly machine on the always-on plan ~$5/mo,
Fly Postgres ~$5/mo (1GB), Vercel hobby free. ~$10/mo all-in.

### 4.0 Prerequisites

- Fly account + `flyctl` (`brew install flyctl` then `fly auth login`).
- Vercel account.
- A domain you control.
- `eidan-cli` installed on your laptop, and an ops repo scaffolded
  with `eidan init <name>`. Everything per-deploy lives in
  `topology.yml` (vault-encrypt the secrets); `eidan deploy` reads
  it, renders `fly.toml`, pushes secrets, deploys. Nothing per-
  operator lives in this repo's tree, so `git pull` keeps working
  forever.

> **Legacy `infra/fly/` artefacts.** `infra/fly/Dockerfile` and
> `infra/fly/fly.toml.example` are still in the tree for operators
> who build images locally rather than pulling the published
> `ghcr.io/sielay/eidan:<tag>`. The CLI doesn't use them — they
> stay only as a manual fallback.

### 4.1 fly.toml (rendered by `eidan deploy`)

`fly.toml` is rendered from your `topology.yml` by `eidan deploy`
into a per-deploy `<topology_dir>/.eidan-runtime/<node>/fly.toml`,
then handed to `fly deploy -c <path>`. You don't write or edit it
by hand. Per-node fields the renderer reads:

- `app`, `region`, `image` (defaults to `ghcr.io/sielay/eidan:latest`),
  `http_port`, `cors_origins`, `disable` (becomes `EIDAN_DISABLED_PLUGINS`
  in `[env]`), `node_id`, `node_type`.

See [§4.5](#45-deploy--custom-domain) for the workflow.

### 4.3 Create the app (+ optional Fly Postgres)

Create the app first — `fly postgres attach` (if you use it
below) needs the target app to exist:

```bash
fly apps create eidan-api --org personal       # match `app =` in your fly.toml
```

Pick **one** Postgres path:

#### Option A — bring your own Postgres (Supabase / Neon / RDS / …)

Skip the Fly Postgres commands entirely. You'll set `DATABASE_URL`
by hand in §4.4 using the connection string from your provider.
Use the `postgresql+asyncpg://` scheme; for managed providers that
require TLS, append `?ssl=require`:

```
postgresql+asyncpg://<user>:<password>@<host>:5432/<db>?ssl=require
```

Then jump to §4.4.

#### Option B — Fly-managed Postgres

```bash
fly postgres create --name eidan-pg --org personal --region lhr \
  --vm-size shared-cpu-1x --volume-size 1
fly postgres attach --app eidan-api eidan-pg
```

`fly postgres attach` writes `DATABASE_URL` as a secret using the
`postgres://` scheme. eidan needs `postgresql+asyncpg://`. Fly
doesn't expose secret values through the CLI, so read the URL
back from inside a running machine and re-set it under the
correct scheme:

```bash
# 1. Pull the attached URL from inside the machine (Fly masks
# the value in `fly secrets list` but exposes it as an env var
# to the running process).
fly ssh console --app eidan-api -C 'printenv DATABASE_URL'
# → postgres://<user>:<password>@<host>:5432/<db>?sslmode=disable

# 2. Re-set it with the asyncpg scheme. Quote carefully because
# the password may contain shell metacharacters.
fly secrets set --app eidan-api \
  DATABASE_URL='postgresql+asyncpg://<user>:<password>@<host>:5432/<db>'
```

Strip the `?sslmode=disable` query — asyncpg uses different
TLS knobs. If you need TLS, append `?ssl=require` instead.

### 4.4 Runtime secrets (via `eidan deploy --tags secrets`)

Secrets — `DATABASE_URL`, `EIDAN_AUTH_MASTER_KEY`, provider API
keys, SMTP creds, GitHub PAT — go in `topology.yml` (vault-encrypt
the sensitive ones). `eidan deploy --tags secrets --node fly-prod`
pushes them via `fly secrets set --app <app> KEY=value …`.

Non-secret runtime config (`EIDAN_HTTP_HOST`, `EIDAN_DEPLOYMENT_MODE`,
`EIDAN_HTTP_CORS_ORIGINS`, `EIDAN_SENTRY_ENABLED`,
`EIDAN_DISABLED_PLUGINS`, node identity) lands in the `[env]`
block of the rendered `fly.toml` instead — see §4.1.

`EIDAN_SENTRY_ENABLED` defaults to `0` on Fly because the 5-minute
tick would burn LLM cost on every auto-stop machine. Opt in
per-node via `sentry.enabled: true` if the Fly app is your
primary long-lived node and there's no Pi running the tick.

### 4.5 Deploy + custom domain

```bash
eidan deploy --node fly-prod                  # render fly.toml + push secrets + fly deploy + bundle install
eidan deploy --node fly-prod --tags deploy    # just the deploy step
fly certs create --app eidan-api api.yourdomain.com
# Add the A + AAAA records Fly prints, wait for "Issued".
```

`eidan deploy` calls `fly deploy -c <rendered fly.toml> --image
<topology.image or ghcr.io/sielay/eidan:latest>`. Pin a specific
release tag via `defaults.image:` in `topology.yml` to stop rolling
`latest` in production.

The custom domain is **not cosmetic** — the backend hostname must
share its registrable domain with the frontend or the
refresh-token cookie goes third-party and `SameSite=Lax` drops
it. See [§6.1](#61-backend-custom-domain-is-load-bearing) before
picking a name.

Run migrations once after the first deploy. Use
`eidan admin db migrate` rather than bare `alembic` so the runner
picks up each plugin's private-schema migrations in addition to
core:

```bash
fly ssh console --app eidan-api -C 'uv run eidan admin db migrate'
```

Skip if another node (the Pi, a laptop bootstrap) has already
migrated this Postgres — alembic is version-tracked and a re-run
is a no-op.

Smoke-check:

```bash
curl https://api.yourdomain.com/api/auth/config
# Expect {"provider":"native", ...}
```

### 4.6 Paid bundles (via `eidan deploy --tags plugins`)

Declare the bundles in `nodes.<name>.bundles` in `topology.yml`,
then:

```bash
eidan deploy --node fly-prod --tags plugins
```

`eidan deploy` opens a `fly ssh console`, exports `EIDAN_PLUGIN_SOURCE`
+ `EIDAN_GITHUB_TOKEN` (from the topology) only for the duration of
the install command, then runs `eidan admin plugin install <bundle>`
per declared bundle. The plugin tree lands on the Fly volume mounted
at `/var/lib/eidan/plugins`; bundle swaps don't require a rebuild
because the published image is core-only.

**Note:** the published Fly image ships under
`ghcr.io/sielay/eidan:latest` (or a pinned tag via `topology.image`).
Paid bundles install at runtime via this path — there's one image
per release rather than one per (release × bundle set).

### 4.7 Frontend

Follow §8. `NEXT_PUBLIC_EIDAN_BACKEND_URL=https://api.yourdomain.com`.

### 4.8 Optional: CI deploy

This repo intentionally does **not** carry a `.github/workflows/`
deploy entry — the public mirror should not ship CI that talks to
someone else's Fly account. Run CI from your own ops repo. A
minimal job runs `eidan deploy` against your committed
`topology.yml`:

```yaml
# .github/workflows/deploy.yml in YOUR ops repo.
# Repo layout assumed:
#   ./topology.yml    ← vault-encrypted, committed
#   ./.vault-pass     ← injected from a GitHub Actions secret
name: Deploy
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency: { group: eidan-deploy, cancel-in-progress: false }
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@1.5
      - run: pipx install eidan-cli
      - run: |
          echo "$VAULT_PASS" > .vault-pass
          chmod 0600 .vault-pass
          eidan deploy --node fly-prod
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
          VAULT_PASS:    ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
```

Generate the Fly token with `fly tokens create deploy`. Pin actions
to a commit SHA for production; the `@1.5` tag above is shown for
brevity.

---

## 5. Recipe: Distributed (Fly API + Pi worker + Vercel UI + Supabase Postgres)

The reference multi-instance shape: Fly handles latency-sensitive
HTTP, the Pi runs the always-on workload (behaviour dispatcher,
Sentry, future Claude Code worker), Vercel serves the UI, Supabase
holds shared state. Postgres advisory locks coordinate leader-only
work — whichever instance grabs the lock first owns it.

This recipe is composed from §3 and §4; treat the cross-references
as the authoritative steps and use this section only for the deltas.

### 5.0 Topology

- **Fly machine** in your nearest region — serves `/api/*`.
  Stateless, auto-stops on idle.
- **Raspberry Pi** at home — leader-elected workload only. No
  public HTTP. Same Postgres as Fly.
- **Vercel** — Next.js UI on `app.yourdomain.com`.
- **Supabase Postgres** — DB only.

Estimated monthly cost: Fly ~$5 + Supabase free tier (~$25 if you
outgrow it) + Vercel free + Pi sunk cost = ~$5–30/mo all-in.

### 5.1 Supabase Postgres

Follow §3.4 option B. The same `DATABASE_URL` will be used by
both Fly and the Pi.

### 5.2 Topology shape

Both nodes live in the same `topology.yml`. The shape:

```yaml
defaults:
  auth_master_key: !vault | ...     # SAME value on every node
  auth_allowed_email: you@example.com
  database_url: !vault | ...        # SAME Supabase URL on every node
  image: ghcr.io/sielay/eidan:v0.1.0

nodes:
  fly-prod:
    target: fly
    app: eidan-api
    region: lhr
    provider: { name: anthropic, default_model: claude-sonnet-4-6, api_key: !vault | ... }
    # sentry.enabled defaults to false on Fly — the Pi runs the tick
  kasha:
    target: pi
    host: 192.168.1.100
    ssh_user: pi
    http_host: 127.0.0.1            # Pi doesn't serve public HTTP
    provider: { name: ollama, default_model: phi3 }
    sentry: { enabled: true, model: phi3 }
```

One `eidan deploy` reconciles both. The auth master key + database
URL come from `defaults:` so they're guaranteed byte-identical
across nodes.

### 5.3 Bootstrap deltas

Each target still needs one-time setup `eidan deploy` doesn't
automate:

- **Fly** — `fly apps create eidan-api` once before the first deploy
  (cf. §4.3). Skip `fly postgres create` / `attach` — use the
  Supabase URL from `defaults.database_url:`.
- **Pi** — §3.0–3.5 (service user, uv, Ollama, Postgres choice
  pointing at Supabase, initial clone + migration). Skip §3.4
  (local Postgres) — use the Supabase URL.

### 5.4 Vercel UI

Follow §8 with `NEXT_PUBLIC_EIDAN_BACKEND_URL=https://api.yourdomain.com`
(the Fly app, not the Pi).

### 5.5 Leader-election sanity check

Watch both journals after both backends are up:

```bash
# Pi
sudo journalctl -u eidan-backend -f | grep dispatcher

# Fly
fly logs -a eidan-api | grep dispatcher
```

The Pi should print `behaviour dispatcher started with N cron
job(s)`. The Fly machine should print `another instance owns the
dispatcher lock`. If both claim ownership, you have a Postgres
configuration problem (two databases instead of one) — stop and
diagnose before continuing.

### 5.6 End-to-end smoke

From a clean browser:

1. `https://app.yourdomain.com` → click sign-in.
2. Magic link arrives in email → click → land on the conversation
   list.
3. New conversation → "what is the time in london?" → SSE stream
   produces `chunk` frames, no `[interrupted]`. (This call goes
   through Fly → Anthropic; the Pi's Ollama is idle for foreground
   work.)
4. Wait 5–10 minutes, then `journalctl -u eidan-backend` on the
   Pi → Sentry tick rows visible.

---

## 6. Reference: Auth

Auth is native — see [011](./011_AUTH_FLOW.md). The host mints +
verifies its own RS256 JWTs against a keypair stored encrypted in
`eidan.auth_keypair`; the master key
(`EIDAN_AUTH_MASTER_KEY`) is the only external input. There is no
third-party identity provider, no JWKS round-trip, no OAuth
broker.

Set these on **every backend host** (Pi, Fly, Heroku, …) before
the first boot:

| Env var                       | Why                                                                                |
|-------------------------------|------------------------------------------------------------------------------------|
| `EIDAN_AUTH_MASTER_KEY`       | HKDF-derives the Fernet key sealing the RS256 keypair + every vault entry. **Same value on every node.** |
| `EIDAN_AUTH_ALLOWED_EMAIL`    | The single email the magic-link endpoint will mint a link for. Unset = refuse-all.|
| `EIDAN_SMTP_*`                | Outbound mail for the magic link. Optional — the link is always logged regardless. |
| `EIDAN_DEPLOYMENT_MODE=production` | Switches the refresh cookie to `Secure` + suppresses the dev link echo.     |

Generate the master key once:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

**Back it up out-of-band** (1Password / hardware key / paper in a
safe). Rotating it later means losing the contents of
`eidan.auth_keypair`, `eidan.auth_mfa_totp`, and
`eidan.secrets_vault` — see
[SECRETS §10](./012_SECRETS.md#10-master-key-rotation).

Multi-instance has no per-instance auth state to synchronise —
every host reads the keypair from Postgres at boot.

### 6.1 Backend custom domain is load-bearing

The verify endpoint sets `eidan_refresh` as an `httpOnly; SameSite=Lax`
cookie scoped to `/api/auth/refresh`. That cookie is what keeps the
session alive across access-token expiries — without it, the SPA falls
back to a fresh magic-link round-trip on every reload.

`SameSite=Lax` requires the request that triggers the cookie's send to
be **same-site** with the cookie's origin. "Same-site" here is the
**registrable domain** (eTLD+1), not the hostname:

| Frontend host         | Backend host             | Cookie sent? |
|-----------------------|--------------------------|--------------|
| `app.example.com`     | `api.example.com`        | yes — same registrable domain (`example.com`) |
| `example.com`         | `api.example.com`        | yes — same registrable domain |
| `app.example.com`     | `eidan-api.fly.dev`      | **no — third-party, browser drops `Set-Cookie`** |
| `app.example.com`     | `api.other-tld.dev`      | **no — different registrable domain** |

Practical consequence: **before you pick a frontend domain, pick a
backend custom domain that shares its registrable domain.** The Fly
recipe in §4.5 already includes the cert step:

```bash
fly certs create --app eidan-api api.yourdomain.com
# add the CNAME / A+AAAA records Fly prints, wait for "Issued".
```

then set `NEXT_PUBLIC_EIDAN_BACKEND_URL=https://api.yourdomain.com` in
the frontend (§8) and add the frontend origin to
`EIDAN_HTTP_CORS_ORIGINS` in your `fly.toml` (§4.1).

`SameSite=None; Secure` would also paper over a cross-registrable-domain
shape, but it is the dead-man-walking option: Safari ITP blocks it
already, Brave blocks it by default, and Chrome's third-party cookie
deprecation kills it on the rest. The custom-domain shape is the only
path that keeps working.

---

## 7. Reference: Database

Any Postgres ≥ 13 with `gen_random_uuid()`, `tsvector`, generated
columns, and partial indexes. The host expects to own the `eidan`
schema and operate on it as a regular Postgres connection — no
data API, no PostgREST.

| Host                | Used in     | Notes                                                                    |
|---------------------|-------------|--------------------------------------------------------------------------|
| **Postgres on Pi**  | §3 option A | Simplest, single point of failure for compute *and* data. Backup nightly.|
| **Supabase**        | §3 option B, §5 | Managed Postgres + Studio for inspection. Free tier covers single-operator. |
| **Fly Postgres**    | §4          | Colocated with Fly machines. ~$5/mo for 1GB.                             |
| **Neon**            | (any)       | Serverless, autoscales. Good for cloud-only deployments.                 |
| **RDS / Cloud SQL** | (any)       | Anything with a stable `postgresql://` connection string works.          |

The `eidan_app` role is created automatically by
`migrations/versions/20260514_000005_eidan_app_role.py` when
`EIDAN_CREATE_APP_ROLE=true` + `EIDAN_APP_DB_PASSWORD=<strong>`
are set on the first migration run. Recommended over running
migrations as `postgres` superuser long-term.

---

## 8. Reference: Vercel frontend

The Next.js app is a stock App Router project. Used by every
recipe above; spelled out once here.

1. Vercel dashboard → **New project** → import this repo, root
   `apps/web`.
2. **Framework preset**: Next.js. **Build command**:
   `pnpm --filter @eidan/web build`. **Install command**:
   `pnpm install --frozen-lockfile`. **Output directory**:
   `apps/web/.next` (default).
3. **Environment variables**:
   - `NEXT_PUBLIC_EIDAN_BACKEND_URL=https://api.yourdomain.com`
     (or wherever the recipe's backend lives). The backend host MUST
     share its registrable domain with the frontend host configured in
     step 4 — see [§6.1](#61-backend-custom-domain-is-load-bearing).
     Pointing at `eidan-api.fly.dev` while the frontend is on
     `app.yourdomain.com` will silently break the refresh cookie.
4. Deploy. Set the production domain to `app.yourdomain.com`
   under **Settings → Domains**.
5. Smoke-check: visit `https://app.yourdomain.com`, click sign-in.
   The magic link arrives by email; the verify round-trip should
   land you on the conversation list.

The frontend talks directly to the native auth endpoints
(`/api/auth/magic-link`, `/api/auth/verify`, `/api/auth/refresh`).
No third-party SDK in the bundle.

**Alternative hosts:** Fly machine (Node runtime), Heroku web
dyno. Same trade-offs apply — you give up Vercel's edge cache and
preview-per-branch for a single billing surface. Vercel is the
default unless you have a specific reason to consolidate.

---

## 9. Observability

Every backend process — Pi, Fly, Heroku dyno, k8s pod, local
laptop — writes per-node telemetry into the shared Postgres so
the operator (or an agent acting on the operator's behalf) can
answer "which nodes are alive, and what is each one doing right
now?". Full spec in [docs/024_NODE_TELEMETRY.md](./024_NODE_TELEMETRY.md);
this section is the deploy-shaped summary.

### 9.1 What gets emitted, for free

Per process at boot, the runtime resolves a `(node_id, node_type,
metadata)` triple — auto-detected from `FLY_MACHINE_ID` / `DYNO` /
`KUBERNETES_SERVICE_HOST` / hostname unless `EIDAN_NODE_ID` /
`EIDAN_NODE_TYPE` override it (pin via per-node `node_id:` /
`node_type:` in `topology.yml`).

Two writes happen continuously:

- **`eidan.node_heartbeats`** — UPSERTed every 30 s. One row per
  node. Drives the live/stale chip on `/api/admin/nodes`.
- **`eidan.node_events`** — append-only stream. Core emits
  `plugin.activate` (one per plugin), `dispatcher.started`,
  `node.boot`, and `node.shutdown`. Plugins can add their own
  types.

Both writes are fire-and-forget: a transient DB outage logs a
warning and the next 30 s heartbeat retries. The process keeps
running.

### 9.2 Reading it back

Two HTTP routes, gated on a signed-in session:

```bash
curl https://api.yourdomain.com/api/admin/nodes \
  -H "Authorization: Bearer <jwt>"
# { "nodes": [ { node_id, node_type, status, last_seen, seconds_since, metadata, ... }, ... ] }

curl "https://api.yourdomain.com/api/admin/nodes/pi-kasha/events?after_seq=0" \
  -H "Authorization: Bearer <jwt>"
# { "node_id": "pi-kasha", "events": [ { id, seq, ts, type, payload, conversation_id }, ... ] }
```

For ad-hoc inspection on the Pi:

```bash
sudo -u eidan psql "$DATABASE_URL" -c "
  SELECT node_id, node_type, status,
         now() - last_seen AS stale_for,
         metadata
    FROM eidan.node_heartbeats
   ORDER BY last_seen DESC;
"

sudo -u eidan psql "$DATABASE_URL" -c "
  SELECT seq, ts, type, payload
    FROM eidan.node_events
   WHERE node_id = 'pi-kasha'
   ORDER BY seq DESC
   LIMIT 50;
"
```

### 9.3 External log forwarding (BetterStack / Datadog / Axiom / Loki)

Core ships an env-configured HTTP/JSON forwarder
([`apps/backend/eidan_backend/log_forwarding.py`](../apps/backend/eidan_backend/log_forwarding.py))
that attaches at boot. Operator surface is pure env-config in
`/etc/eidan/eidan.env`; no Python file to drop, no `PYTHONPATH`,
nothing to write under `/opt/eidan/`. Spec lives in
[docs/024 §6](./024_NODE_TELEMETRY.md#6-external-log-forwarding).

**BetterStack (Logtail):**

```ini
EIDAN_LOG_FORWARD_URL=https://in.logs.betterstack.com
EIDAN_LOG_FORWARD_TOKEN=<your-source-token>
```

**Datadog:**

```ini
EIDAN_LOG_FORWARD_URL=https://http-intake.logs.datadoghq.com/api/v2/logs
EIDAN_LOG_FORWARD_HEADERS={"DD-API-KEY":"<your-api-key>"}
```

> **systemd-`EnvironmentFile=` quoting.** systemd splits
> unquoted values on whitespace. The JSON above has no spaces
> on purpose so it parses cleanly. If you keep the spaces,
> single-quote the value:
> `EIDAN_LOG_FORWARD_HEADERS='{"DD-API-KEY": "<key>"}'`.

**Axiom / Honeycomb / any HTTPS intake that accepts POST + JSON:**
same shape as BetterStack — set `URL` plus either `TOKEN`
(`Authorization: Bearer`) or `HEADERS` (anything else the intake
wants).

Restart the service (`sudo systemctl restart eidan-backend`) and
every `telemetry.*` event lands in the intake. The envelope
carries `event=` and `node_id=` on every telemetry event
record; `payload=` and `conversation_id=` appear when the
emitter set them (including node-level lifecycle events when
they have extra details — for example,
`telemetry.heartbeat_started` includes
`payload.interval_seconds`; `conversation_id` is set only on
turn-bound events). Full field reference in
[docs/024 §6.2](./024_NODE_TELEMETRY.md#62-json-envelope). The
forwarder is non-blocking (POSTs happen on a background thread)
and swallows network failures — a dead intake doesn't drag the
process; the next log line tries again.

> **Heads-up on log levels.** The forwarder only sees records the
> root logger lets through; it deliberately does not mutate the
> root level. The `eidan-backend-http` entry point already lifts
> root to whatever `EIDAN_HTTP_LOG_LEVEL` is set to (default
> `info`), so the env-only operator surface is intact — just add
> `EIDAN_HTTP_LOG_LEVEL=info` (or whichever floor you want
> forwarded) to `/etc/eidan/eidan.env` and restart. The one
> edge: if `EIDAN_HTTP_LOG_FILE=""` (file logging disabled), the
> custom log config that lifts root isn't built and uvicorn's
> stock config keeps root at `WARNING`. Detail in
> [docs/024 §6.1](./024_NODE_TELEMETRY.md#61-env-vars).

#### Loki (via relay)

Loki wants a specific envelope shape that doesn't match eidan's
flat JSON, so the direct env-config recipe above doesn't apply.
Point eidan at a Vector / Fluent Bit relay that translates flat
JSON → Loki's `streams[]` envelope, or scrape `journalctl -u
eidan-backend` from Promtail's `systemd_journal` source. Detail
in [docs/024 §6.5](./024_NODE_TELEMETRY.md#65-loki).

Without `EIDAN_LOG_FORWARD_URL` set, telemetry events still mirror via Python
logging — check `journalctl -u eidan-backend` and/or `EIDAN_HTTP_LOG_FILE`
(default `logs/backend.log`); on Fly, use `fly logs -a eidan-api`.

### 9.4 Retention

`node_events` is immutable, no TTL today (matches the `llm_calls`
posture in [CLAUDE.md](../CLAUDE.md) → *Conventions*). When event
volume on a real deployment starts to hurt, the cleanup lands as
a small core plugin or behaviour — not a schema change. Until
then, the trail accumulates.

---

This document is intentionally a menu. Per-vendor knobs (exact
env-var names for SMTP providers, DNS record forms, build flags)
live with the vendor and in this repo's `.env.example`.
