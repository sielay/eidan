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

`DATABASE_URL` in §3.6 will be:
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
(see §3.6 for why):

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

### 3.6 Env file

Write `/etc/eidan/eidan.env`, root-owned, group-readable by `eidan`:

```ini
# --- Database ------------------------------------------------------
DATABASE_URL=postgresql+asyncpg://eidan_app:CHANGE-ME@127.0.0.1:5432/eidan
# (or the Supabase URL from §3.4 option B)

# --- Auth ----------------------------------------------------------
# MUST be byte-identical to the value on every other node that
# connects to this Postgres (laptop bootstrap, Fly machines, other
# Pis). The keypair in eidan.auth_keypair and every row in
# eidan.secrets_vault is Fernet-sealed with HKDF(this); a node with
# a different value can't decrypt them and will fail boot with
# "EIDAN_AUTH_MASTER_KEY changing since the row was sealed" at
# eidan_backend/auth_native/keys.py. If you've already bootstrapped
# from a laptop, copy the value from THAT .env — do not regenerate.
EIDAN_AUTH_MASTER_KEY=<the-key-from-3.5-or-from-the-bootstrapping-node>
EIDAN_AUTH_ALLOWED_EMAIL=you@yourdomain.com
EIDAN_DEPLOYMENT_MODE=production

# --- HTTP listener -------------------------------------------------
# Bind to 0.0.0.0 if you'll point the Vercel frontend at this Pi
# directly (via tailscale / cloudflared / wireguard). Bind to
# 127.0.0.1 if the Pi is behind a reverse proxy on the same box.
EIDAN_HTTP_HOST=0.0.0.0
EIDAN_HTTP_PORT=8000

# --- LLM provider (host-wide) --------------------------------------
EIDAN_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
EIDAN_DEFAULT_MODEL=phi3

# --- Sentry plugin (per-plugin override) ---------------------------
# Sentry pins its own model so it stays cheap even when the host's
# default model gets swapped later. Phase 1 detectors are
# deterministic; this slot is read by the local-model adapter
# once it ships.
EIDAN_SENTRY_ENABLED=1
EIDAN_SENTRY_TICK_INTERVAL=PT5M
EIDAN_SENTRY_MODEL=phi3

# --- SMTP for magic-link (optional) --------------------------------
# Omit to fall back to "link printed in journald". The link is
# always logged regardless.
EIDAN_SMTP_HOST=smtp.fastmail.com
EIDAN_SMTP_PORT=465
EIDAN_SMTP_USER=...
EIDAN_SMTP_PASSWORD=...
EIDAN_SMTP_FROM=eidan@yourdomain.com
```

Lock the perms:

```bash
sudo chown root:eidan /etc/eidan/eidan.env
sudo chmod 0640 /etc/eidan/eidan.env
```

### 3.7 systemd unit

`/etc/systemd/system/eidan-backend.service`:

```ini
[Unit]
Description=Eidan backend (Pi)
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=eidan
Group=eidan
WorkingDirectory=/opt/eidan
EnvironmentFile=/etc/eidan/eidan.env
ExecStart=/home/eidan/.local/bin/uv --directory /opt/eidan run eidan admin server
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Boot it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eidan-backend
sudo journalctl -u eidan-backend -f
```

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

### 3.11 Updating

The Pi is the simplest update story — a cron job that pulls and
restarts is the usual shape:

```bash
sudo -u eidan bash -lc '
  cd /opt/eidan
  git fetch --tags
  git checkout v0.1.1                          # next tagged release
  /home/eidan/.local/bin/uv sync --no-dev
'
sudo systemctl restart eidan-backend
```

If a release ships migrations, re-run §3.5's `alembic upgrade
head` before the restart.

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
- A vanilla clone of this repo. **You don't fork and you don't
  commit anything into it.** Everything per-deploy is either a
  build-time flag on `fly deploy` or a runtime secret in
  `fly secrets set`. The deploy artifacts (`infra/fly/Dockerfile`,
  `infra/fly/fly.toml.example`) are tracked upstream and consumed
  as-is, so `git pull` keeps working forever.

### 4.1 Tracked deploy artifacts (no fork, no edits)

The repo ships two files you consume without editing:

- `infra/fly/Dockerfile` — the build. Python 3.12 + uv + the
  workspace, with two optional build args (`EIDAN_BUNDLES` and
  `EIDAN_PLUGIN_SOURCE`) and one build secret (`github_token`)
  that drive paid-bundle install at image-build time. Core-only
  deploys pass nothing and behave like a stock build. The file
  itself documents every knob in its header.
- `infra/fly/fly.toml.example` — the app config. Copy it **once**
  into a path you control (your own ops repo, or a gitignored
  `fly.toml` on your laptop) and edit `app`, `primary_region`,
  and `EIDAN_HTTP_CORS_ORIGINS`. Your `fly.toml` never enters
  this repo.

```bash
# One-time, on your machine:
cp infra/fly/fly.toml.example ~/ops/eidan-fly.toml
$EDITOR ~/ops/eidan-fly.toml          # app name + region + CORS origin
```

From here on, every `fly` command takes `-c ~/ops/eidan-fly.toml`.

### 4.2 (reserved)

`fly.toml` is no longer authored inline — see §4.1.


### 4.3 Create the app + Postgres

`fly postgres attach` needs the target app to exist, so create it
first:

```bash
fly apps create eidan-api --org personal       # match `app =` in your fly.toml
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

(Alternatively use Neon / Supabase / RDS — set `DATABASE_URL` by
hand in §4.4; you already know the password.)

### 4.4 Runtime secrets (auth + provider + SMTP)

Generate the master key once (`python -c "import secrets;
print(secrets.token_urlsafe(48))"`) and store it offline. Then:

```bash
fly secrets set --app eidan-api \
  EIDAN_AUTH_MASTER_KEY="<recorded-offline>" \
  EIDAN_AUTH_ALLOWED_EMAIL="you@yourdomain.com" \
  EIDAN_PROVIDER="anthropic" \
  EIDAN_DEFAULT_MODEL="claude-sonnet-4-6" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  EIDAN_SENTRY_ENABLED="0" \
  EIDAN_SMTP_HOST="smtp.fastmail.com" \
  EIDAN_SMTP_PORT="465" \
  EIDAN_SMTP_USER="..." \
  EIDAN_SMTP_PASSWORD="..." \
  EIDAN_SMTP_FROM="eidan@yourdomain.com"
```

**Why `EIDAN_SENTRY_ENABLED=0` here:** the Sentry tick fires every
5 minutes and would hammer Anthropic on a Fly machine that
otherwise auto-stops to zero. Run Sentry on the Pi (§3) or wait
for the local-model adapter. If you do want Sentry on Fly, pair it
with a local provider — out of scope for this recipe.

### 4.5 Deploy + custom domain

Core-only deploy from a vanilla checkout — no in-repo edits, no
`infra/fly/fly.toml` (you use the copy you made in §4.1). The
trailing `.` is the build context; run from the eidan checkout
root so `--dockerfile infra/fly/Dockerfile` and the Dockerfile's
`COPY` lines both resolve:

```bash
cd /path/to/your/eidan/checkout
fly deploy -c ~/ops/eidan-fly.toml --dockerfile infra/fly/Dockerfile .
fly certs create --app eidan-api api.yourdomain.com
# Add the A + AAAA records Fly prints, wait for "Issued".
```

To install paid bundles **at image-build time** (no fork, no source
checkout of the bundle on this machine), pass `EIDAN_BUNDLES` +
`EIDAN_PLUGIN_SOURCE` as build args and the GitHub token as a
build secret. The CLI's `eidan admin plugin install` path inside
the Dockerfile then clones the bundle repos using
[`docs/018 §3`](./018_DISTRIBUTION_AND_BUNDLES.md)'s
private-org flow. The token is mounted via
`--build-secret` so it never lands in an image layer:

```bash
mkdir -p ~/.eidan
install -m 0600 /dev/null ~/.eidan/github-token       # 0600 before any byte lands
printf '%s' "$YOUR_GITHUB_PAT" > ~/.eidan/github-token
fly deploy -c ~/ops/eidan-fly.toml \
  --dockerfile infra/fly/Dockerfile \
  --build-arg EIDAN_BUNDLES=eidan-pro,eidan-lifestyle \
  --build-arg EIDAN_PLUGIN_SOURCE=gh:sielay \
  --build-secret id=github_token,src=$HOME/.eidan/github-token \
  .
```

(`install -m 0600 /dev/null ...` creates the file with mode `0600`
*before* the PAT is written, so the token never exists on disk in a
world-readable state — a plain `echo > file` honours the shell's
umask and may leave the file readable to other local users.)

(Swapping bundles without rebuilding the image requires runtime
plugin install to a Fly volume — currently roadmap, see
[ROADMAP.md](./ROADMAP.md).)

Run migrations (one-off, against the Fly Postgres). Use `eidan
admin db migrate` rather than bare `alembic` so the runner picks
up each plugin's private-schema migrations in addition to core:

```bash
fly ssh console --app eidan-api -C 'uv run eidan admin db migrate'
```

Skip this step if another node (a laptop bootstrap, the Pi) has
already migrated this Postgres — alembic is version-tracked and
a re-run is a no-op, but skipping keeps the deploy clean.

Smoke-check:

```bash
curl https://api.yourdomain.com/api/auth/config
# Expect {"provider":"native", ...}
```

### 4.6 Frontend

Follow §8. `NEXT_PUBLIC_EIDAN_BACKEND_URL=https://api.yourdomain.com`.

### 4.7 Optional: CI deploy

This repo intentionally does **not** carry a `.github/workflows/`
deploy entry — the public mirror should not ship CI that talks to
someone else's Fly account. Run CI from your own ops repo. A
minimal job that lives in **your ops repo** (which holds your
`fly.toml`) and pulls upstream eidan into a subdirectory looks
like:

```yaml
# .github/workflows/deploy-api.yml in YOUR ops repo.
# Repo layout assumed:
#   ./fly.toml        ← your copy of fly.toml.example, edited
#   ./eidan/          ← upstream sielay/eidan, checked out below
name: Deploy API
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency: { group: fly-deploy, cancel-in-progress: false }
    steps:
      - uses: actions/checkout@v4        # your ops repo (holds fly.toml)
      - uses: actions/checkout@v4        # upstream eidan into ./eidan
        with:
          repository: sielay/eidan
          ref: v0.1.0
          path: eidan
      # Pin third-party actions: floating refs like @master can ship
      # surprise behaviour. `1.5` is the latest tagged release at the
      # time of writing; for production, pin to a commit SHA instead.
      - uses: superfly/flyctl-actions/setup-flyctl@1.5
      - run: |
          flyctl deploy --remote-only \
            -c "$GITHUB_WORKSPACE/fly.toml" \
            --dockerfile eidan/infra/fly/Dockerfile \
            eidan
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

The trailing `eidan` positional arg tells `flyctl deploy` to use
that directory as the build context — the Dockerfile's `COPY`
lines resolve against it. Generate the token with
`fly tokens create deploy`.

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

### 5.2 Fly API

Follow §4 with these deltas:

- **§4.3** — `fly apps create eidan-api` still applies; **skip the
  `fly postgres create` + `fly postgres attach` lines** and set
  `DATABASE_URL` to the Supabase URL via `fly secrets set` instead.
- **Set `EIDAN_SENTRY_ENABLED=0`** on Fly (already done in §4.4).
  Sentry runs on the Pi in this topology; Fly leaves the advisory
  lock for the Pi to grab.
- The auth master key MUST be the same value on Fly and the Pi.

### 5.3 Pi worker

Follow §3 with these deltas:

- **Skip §3.4** (local Postgres). Use the Supabase URL.
- **§3.6 env file changes:**
  - `EIDAN_HTTP_HOST=127.0.0.1` (Pi doesn't serve public HTTP).
  - `EIDAN_PROVIDER=ollama`, `EIDAN_DEFAULT_MODEL=phi3` — the Pi
    uses local inference for its own foreground work.
  - `EIDAN_SENTRY_ENABLED=1`, `EIDAN_SENTRY_MODEL=phi3`.
  - The same `EIDAN_AUTH_MASTER_KEY` as Fly.
- **Skip §3.9** (Vercel frontend — set up once in §5.4 below, not
  per-recipe).

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
     (or wherever the recipe's backend lives).
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

This document is intentionally a menu. Per-vendor knobs (exact
env-var names for SMTP providers, DNS record forms, build flags)
live with the vendor and in this repo's `.env.example`.
