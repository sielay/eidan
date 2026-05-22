# Deployment

Eidan ships as a **Python backend** plus a **Next.js frontend** plus
**Postgres** as the shared source of truth. The backend is designed
to run multi-instance (Fly.io regions, a Pi plus a cloud node, etc.)
behind a load balancer or as independent peers — Postgres holds
state, and work that needs a single owner (cron, leases, the
sequencer in [AGENTIC LOOP](./005_AGENTIC_LOOP.md)) elects a leader
rather than assuming one process. Single-instance is a valid
deployment, not a design assumption.

This document is the **deployment menu**: which backend host, which
frontend host, which auth provider, and how they fit together. It is
intentionally short — vendor-specific runbooks (env vars, redirect
URIs, build commands) live with the vendor's own docs.

## 1. The pieces

| Component                | What it is                                           | State                        |
|--------------------------|-------------------------------------------------------|------------------------------|
| **Backend** (`apps/backend`) | Python / FastAPI. Owns the agentic loop, MCP server / client, providers, persistence. | Stateless per process; reads / writes Postgres. |
| **Frontend** (`apps/web`)  | Next.js (App Router). Renders chat UI, dashboards, plugin frontends. | Stateless; calls backend over HTTP / WS. |
| **Database**             | Postgres 13+ with the `eidan` schema.                 | Single shared instance per deployment. |
| **Auth**                 | Native — host mints + verifies RS256 JWTs against a keypair stored encrypted in Postgres. | Internal. No third-party identity provider. |

## 2. Backend hosting

Pick one. The backend is a single FastAPI process; spin up as many
processes as you need.

### 2.1 Fly.io

Recommended default for any deployment that wants global presence
or zero-downtime rollouts. Each Fly machine is one backend process;
auto-scaling and health checks come from Fly. Postgres lives on
Fly (Fly Postgres) or an external provider (Neon, RDS, …).
Suits **multi-instance with leader election** out of the box —
multiple regions, one Postgres, leader role decided by a Postgres
advisory lock.

Notes:
- Fly machines are **ephemeral**. Long-running jobs that need
  uninterrupted execution (large migrations, long classifier runs)
  belong on a Pi or a long-lived host, not on a Fly machine that
  may rotate.
- The `fly.toml` checked-in to the repo holds only non-secret
  config; secrets are set via `flyctl secrets set`.

### 2.2 Heroku

Works as a vanilla web dyno (one process per dyno). Heroku is the
simplest "click to deploy" path for a single-instance, single-region
hobby deployment. Limitations:

- No long-running jobs in the standard tier (the dyno restarts every
  24h). For an agent that runs long classifier or critic chains,
  budget around the restart or run a worker dyno alongside.
- Heroku Postgres works but is more expensive at scale than Fly /
  Neon.

### 2.3 Raspberry Pi (or any always-on home node)

The reference "self-hosted on my own hardware" deployment. Run the
backend as a `systemd` service:

```ini
# /etc/systemd/system/eidan-backend.service
[Unit]
Description=Eidan backend
After=network.target

[Service]
Type=simple
User=eidan
WorkingDirectory=/opt/eidan/apps/backend
EnvironmentFile=/etc/eidan/eidan.env
ExecStart=/opt/eidan/.venv/bin/python -m apps.backend
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eidan-backend
journalctl -u eidan-backend -f
```

A Pi is the **right home for long-running work** (jobs that exceed
Fly's machine lifetime, batch ingest, scheduled runs). A common
shape: Pi as the always-on worker, Fly as the latency-sensitive
front for HTTP and WebSocket traffic — Postgres in the middle.

### 2.4 Multi-instance topology (Fly + Pi + …)

The backend is designed for this. Each instance opens its own
Postgres pool; work that must have a single owner is gated by a
Postgres advisory lock. A typical deployment:

- **Fly machines** (≥1, possibly multi-region) — handle inbound
  HTTP / WebSocket. Stateless per machine.
- **Pi (or one designated Fly machine)** — runs the cron / leader
  loop. Picks up the lock at startup; releases it on exit.
- **Postgres** — single shared instance. The bottleneck and the
  source of truth.

There is no message bus today. Cross-instance coordination is
Postgres `LISTEN`/`NOTIFY` plus advisory locks; that ceiling is
fine for the scale this stack targets.

### 2.5 Runbook: Fly API + Pi worker + Vercel UI + Supabase Postgres

The single-operator reference deployment. Step-by-step, top to
bottom. The shape:

- **Fly machine** in `lhr` (or your nearest region) — serves
  `/api/*`. Stateless, auto-stops on idle.
- **Raspberry Pi** at home — runs the leader-elected workload
  (behaviour dispatcher, future Sentry tick, future Claude Code
  worker). Shares one Postgres with Fly.
- **Vercel** — Next.js UI on `app.<your-domain>`. Same auth domain
  as the API, so the refresh cookie scopes cleanly.
- **Supabase Postgres** — DB only. Auth lives in the eidan host
  (`docs/011 §11`); Supabase is just an opinionated managed
  Postgres with a UI for inspection.

Estimated cost at v1: Fly machine on the always-on plan ~$5/mo,
Supabase free tier (or ~$25/mo if you outgrow it), Vercel hobby
free, Pi sunk cost. ~$5–30/mo all-in.

#### Prerequisites

- Fly account + `flyctl` installed (`brew install flyctl` then `fly auth login`).
- Vercel account + `vercel` CLI optional (`pnpm i -g vercel`).
- Supabase account.
- A domain you control (e.g. `eidan.yourdomain.com`) — needed for
  the auth cookie to scope between the API and UI.
- A Raspberry Pi (4 or 5 recommended, 4GB+ RAM) on your home network
  reachable over SSH.
- Local shell with Python 3.12, `uv`, `pnpm`, and a checked-out
  clone of this repo.

#### Step 1 — Supabase project + Postgres role

1. Supabase dashboard → **New project**. Region near your Fly region
   (e.g. `eu-west-1` for `lhr`). Generate a strong DB password and
   record it.
2. Dashboard → **Settings → Database → Connection string → URI
   (direct, port 5432, not the pooler)**. Copy it; you'll convert
   the scheme to asyncpg in step 2.
3. Decide if you want a dedicated `eidan_app` role (recommended) or
   to run as the default `postgres` superuser (faster start, less
   safe). The dedicated role is owned by
   `migrations/versions/20260514_000005_eidan_app_role.py` and is
   created automatically when `EIDAN_CREATE_APP_ROLE=true` +
   `EIDAN_APP_DB_PASSWORD=<strong>` are set during the first
   migration run.
4. From your laptop, with `DATABASE_URL` pointing at Supabase, run
   the migrations:
   ```bash
   DATABASE_URL="postgresql+asyncpg://postgres:<dbpw>@<host>:5432/postgres" \
     EIDAN_CREATE_APP_ROLE=true \
     EIDAN_APP_DB_PASSWORD="<choose-a-strong-password>" \
     EIDAN_AUTH_MASTER_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')" \
     uv run --extra dev alembic -c apps/backend/alembic.ini upgrade head
   ```
   The `EIDAN_AUTH_MASTER_KEY` value is only needed because the
   migration runner imports the auth subsystem at startup; the
   *production* master key is set later as a Fly/Pi secret and
   must be the SAME value across all hosts. Generate it once and
   record it offline — losing it means re-minting the keypair +
   wiping the secrets vault (`docs/012 §10`).
5. Verify in Supabase Studio that `eidan.conversations`,
   `eidan.messages`, etc. exist and that `eidan.auth_keypair`
   contains one row (minted on first import).

#### Step 2 — Fly app for the API

The repo doesn't ship a prod Dockerfile or fly.toml yet — add them
under `infra/fly/` once you've followed the runbook through;
they're not committed because the operator owns app name + region
choices.

1. **Dockerfile** at `infra/fly/Dockerfile`:
   ```dockerfile
   FROM python:3.12-slim-bookworm
   ENV PYTHONUNBUFFERED=1 \
       PYTHONDONTWRITEBYTECODE=1 \
       UV_CACHE_DIR=/tmp/uv-cache
   RUN pip install --no-cache-dir uv
   WORKDIR /app
   COPY pyproject.toml uv.lock ./
   COPY apps/backend ./apps/backend
   COPY plugins ./plugins
   COPY packages/schemas ./packages/schemas
   COPY migrations ./migrations
   RUN uv sync --frozen --no-dev
   EXPOSE 8000
   CMD ["uv", "run", "eidan", "admin", "server", "--host", "0.0.0.0", "--port", "8000"]
   ```

2. **fly.toml** at `infra/fly/fly.toml`:
   ```toml
   app            = "eidan-api"
   primary_region = "lhr"

   [build]
     dockerfile = "infra/fly/Dockerfile"

   [http_service]
     internal_port        = 8000
     force_https          = true
     auto_stop_machines   = "stop"
     auto_start_machines  = true
     min_machines_running = 0  # single-operator — sleep when idle is fine

     [http_service.concurrency]
       type       = "requests"
       soft_limit = 25
       hard_limit = 50

   [env]
     EIDAN_HTTP_HOST       = "0.0.0.0"
     EIDAN_DEPLOYMENT_MODE = "production"
     EIDAN_HTTP_CORS_ORIGINS = "https://app.<your-domain>"
   ```

3. Create the app, set secrets, deploy:
   ```bash
   cd <repo-root>
   fly apps create eidan-api --org personal
   fly secrets set --app eidan-api \
     DATABASE_URL="postgresql+asyncpg://eidan_app:<approwd>@<supabase-host>:5432/postgres" \
     EIDAN_AUTH_MASTER_KEY="<same-as-step-1>" \
     EIDAN_AUTH_ALLOWED_EMAIL="you@yourdomain.com" \
     ANTHROPIC_API_KEY="sk-ant-..." \
     EIDAN_SMTP_HOST="smtp.fastmail.com" \
     EIDAN_SMTP_PORT="465" \
     EIDAN_SMTP_USER="..." \
     EIDAN_SMTP_PASSWORD="..." \
     EIDAN_SMTP_FROM="eidan@<your-domain>"
   fly deploy -c infra/fly/fly.toml .
   ```

4. Wire a custom domain (so the cookie can scope to the apex):
   ```bash
   fly certs create --app eidan-api api.<your-domain>
   ```
   Add the DNS records Fly returns (A + AAAA), then wait for
   `fly certs show api.<your-domain>` to report `Issued`.

5. Smoke-check:
   ```bash
   curl https://api.<your-domain>/api/auth/config
   # Expect {"provider":"native","providers":["email","magic_link"], ...}
   ```

#### Step 3 — Vercel UI

1. Vercel dashboard → **New project** → import this repo, root
   `apps/web`.
2. **Framework preset**: Next.js. **Build command**:
   `pnpm --filter @eidan/web build`. **Install command**:
   `pnpm install --frozen-lockfile`. **Output directory**:
   `apps/web/.next` (default).
3. **Environment variables**:
   - `NEXT_PUBLIC_EIDAN_BACKEND_URL=https://api.<your-domain>`
4. Deploy. Set the production domain to
   `app.<your-domain>` under **Settings → Domains**.
5. Smoke-check: visit `https://app.<your-domain>`, click the
   sign-in button. The magic link arrives by email; the verify
   round-trip should land you on the conversation list.

#### Step 4 — Raspberry Pi worker

Hardware assumption: Pi 4/5 with 4GB+ RAM, Debian Bookworm
(Raspberry Pi OS 64-bit). Reachable from your laptop over SSH.

1. **Install deps** (one-time, as `pi` or your user):
   ```bash
   sudo apt update && sudo apt install -y python3.12 python3.12-venv git curl
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. **Clone + sync the repo**:
   ```bash
   git clone https://github.com/sielay/eidan.git /opt/eidan
   cd /opt/eidan
   git checkout v0.1.0   # pin to a tagged release, not main
   uv sync --no-dev
   ```

3. **Env file** at `/etc/eidan/eidan.env` (root-owned, mode 0600):
   ```ini
   DATABASE_URL=postgresql+asyncpg://eidan_app:<approwd>@<supabase-host>:5432/postgres
   EIDAN_AUTH_MASTER_KEY=<same-as-step-1>
   EIDAN_AUTH_ALLOWED_EMAIL=you@yourdomain.com
   ANTHROPIC_API_KEY=sk-ant-...
   EIDAN_DEPLOYMENT_MODE=production
   # Bind to localhost — the Pi doesn't serve public HTTP, only
   # cron / behaviours / leader-elected workload.
   EIDAN_HTTP_HOST=127.0.0.1
   EIDAN_HTTP_PORT=8000
   ```

4. **systemd unit** at `/etc/systemd/system/eidan-backend.service`:
   ```ini
   [Unit]
   Description=Eidan backend (Pi worker — behaviour dispatcher / leader-elected jobs)
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=eidan
   Group=eidan
   WorkingDirectory=/opt/eidan
   EnvironmentFile=/etc/eidan/eidan.env
   ExecStart=/home/eidan/.local/bin/uv run eidan admin server
   Restart=on-failure
   RestartSec=5s
   StandardOutput=journal
   StandardError=journal

   [Install]
   WantedBy=multi-user.target
   ```

5. **Boot it**:
   ```bash
   sudo useradd -r -s /bin/bash -d /home/eidan -m eidan
   sudo chown -R eidan:eidan /opt/eidan
   sudo systemctl daemon-reload
   sudo systemctl enable --now eidan-backend
   sudo journalctl -u eidan-backend -f
   ```

6. **Leader election sanity check**. The behaviour dispatcher uses
   a Postgres advisory lock — whichever instance grabs it first
   runs cron / schedule jobs; the others see "another instance
   owns the dispatcher lock" in logs and stand by. With Fly's
   `min_machines_running = 0`, the Pi is the de-facto leader
   because it's always on. To verify, watch the Pi journal for
   `[bootstrap] behaviour dispatcher started with N cron job(s)`
   and the Fly logs (`fly logs -a eidan-api`) for the
   "stood-by" message.

#### Step 5 — End-to-end smoke

From a clean browser:

1. `https://app.<your-domain>` → click sign-in.
2. Magic link arrives in your inbox → click it → land on the
   conversation list.
3. New conversation → "what is the time in london?" → SSE stream
   produces `chunk` frames, no `[interrupted]`.
4. From your laptop, against the Pi (over SSH):
   ```bash
   sudo -u eidan -E env $(grep -v '^#' /etc/eidan/eidan.env | xargs) \
     /home/eidan/.local/bin/uv run eidan admin doctor
   ```
   Should report DB connectivity, master key set, migrations at
   head.

#### Step 6 — Secrets management

The master key (`EIDAN_AUTH_MASTER_KEY`) is the single secret you
must NEVER lose and NEVER leak. It seals the RS256 signing key
plus every entry in `eidan.secrets_vault`. Recommended:

- Store it offline (1Password / hardware key / paper in a safe).
- Set it on Fly (`fly secrets set`) and the Pi (`/etc/eidan/eidan.env`).
  Both must hold the exact same value.
- Rotating it is documented in `docs/012 §10` — practically a
  controlled outage where you wipe `eidan.auth_keypair` and
  `eidan.secrets_vault` and re-seed.

Other secrets follow the same pattern but are recoverable:
`ANTHROPIC_API_KEY`, `EIDAN_SMTP_PASSWORD`, the Supabase DB
password.

#### Step 7 — Optional: GitHub Actions deploy on merge to main

If you want hands-off deploys on `main` push, add
`.github/workflows/deploy-api.yml`:

```yaml
name: Deploy API
on:
  push:
    branches: [main]
    paths:
      - "apps/backend/**"
      - "plugins/**"
      - "packages/schemas/**"
      - "migrations/**"
      - "infra/fly/**"
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency: { group: fly-deploy, cancel-in-progress: false }
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only -c infra/fly/fly.toml .
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

Generate the token with `fly tokens create deploy` and add it as
`FLY_API_TOKEN` in repo settings.

The Pi pulls and restarts itself on a `git pull` — there's
nothing to wire up unless you want a similar automation; a cron
job that runs `cd /opt/eidan && git fetch && git checkout <tag>
&& uv sync --no-dev && systemctl restart eidan-backend` is the
usual shape.

## 3. Frontend hosting

The frontend is a stock Next.js App Router app. Pick one.

### 3.1 Vercel

Recommended default. Native target for Next.js: zero-config
deploys, edge caching for static routes, automatic preview
deployments per branch. The frontend talks to the backend over
HTTPS / WSS using the public backend URL.

The frontend talks to the native auth endpoints
(`/api/auth/magic-link`, `/api/auth/verify`, `/api/auth/refresh`)
directly — there is no third-party SDK in the bundle.

### 3.2 Fly.io

Run the Next.js app as a Fly machine (Node runtime). Suits a
deployment that wants the whole stack on one provider. You give
up Vercel's edge cache and preview-per-branch ergonomics; you
gain a single billing surface and the ability to colocate the
frontend with the backend in one region.

### 3.3 Heroku

Deploys as a Node web dyno. Same trade-offs as Fly for the
frontend, plus Heroku's restart cadence. Best for a single hobby
deployment that already lives on Heroku.

## 4. Auth

Auth is native — see [011](./011_AUTH_FLOW.md). The host mints +
verifies its own RS256 JWTs against a keypair stored encrypted in
`eidan.auth_keypair`; the master key
(`EIDAN_AUTH_MASTER_KEY`) is the only external input. There is no
third-party identity provider, no JWKS round-trip, no OAuth
broker.

Set these in your deploy secret store **before** the first boot:

| Env var                       | Why                                                                                |
|-------------------------------|------------------------------------------------------------------------------------|
| `EIDAN_AUTH_MASTER_KEY`       | HKDF-derives the Fernet key sealing the RS256 keypair + every vault entry.        |
| `EIDAN_AUTH_ALLOWED_EMAIL`    | The single email the magic-link endpoint will mint a link for. Unset = refuse-all.|
| `EIDAN_SMTP_*`                | Outbound mail for the magic link. Optional — the link is always logged regardless. |
| `EIDAN_DEPLOYMENT_MODE=production` | Switches the refresh cookie to `Secure` + suppresses the dev link echo.     |

Generate the master key once with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Rotating it later means losing the contents of `eidan.auth_keypair`,
`eidan.auth_mfa_totp`, and `eidan.secrets_vault` — see
[SECRETS §10](./012_SECRETS.md#10-master-key-rotation). Back the
master key up out-of-band.

### 4.1 Multi-instance considerations

Every state the auth subsystem reads or writes lives in Postgres.
Two instances booting against the same database read the same
keypair and verify tokens identically — there is no per-instance
auth state to synchronise. Just set the same
`EIDAN_AUTH_MASTER_KEY` on every machine.

## 5. Database

Any Postgres ≥ 13 with `gen_random_uuid()`, `tsvector`, generated
columns, and partial indexes. The host expects to own the `eidan`
schema and operate on it as a regular Postgres connection — no
data API, no PostgREST.

Recommended hosts:

- **Fly Postgres** — colocated with backend Fly machines.
- **Neon** — serverless Postgres, autoscaled.
- **RDS / Cloud SQL / managed Postgres** — anything with a stable
  connection string.
- **Self-hosted Postgres on a Pi** — works for hobby deployments;
  back up religiously.

## 6. Recommended starting shapes

Pick one based on what you already have running:

| Shape                   | Backend                | Frontend | DB                | Runbook |
|-------------------------|------------------------|----------|--------------------|---------|
| **All Fly**             | Fly machine            | Fly      | Fly Postgres       | — |
| **Hobbyist**            | Heroku web dyno        | Vercel   | Neon               | — |
| **Self-host first**     | Raspberry Pi (`systemd`) | Vercel | Pi Postgres        | — |
| **Distributed (reference)** | Fly machines + Pi worker | Vercel | Supabase Postgres | [§2.5](#25-runbook-fly-api--pi-worker--vercel-ui--supabase-postgres) |

Auth is internal across every shape — set
`EIDAN_AUTH_MASTER_KEY` and `EIDAN_AUTH_ALLOWED_EMAIL` on each
backend host. The components don't know which infrastructure you
chose.

---

This document is intentionally short. Per-vendor runbooks (env
var names, OAuth redirect URIs, build commands) live with the
vendor and in this repo's `.env.example`.
