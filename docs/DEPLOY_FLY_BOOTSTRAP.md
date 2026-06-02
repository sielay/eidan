# Fly bootstrap

One-time setup of a Fly app + Postgres so `eidan deploy --node
<name>` from your laptop has a target. Per Fly app, once;
subsequent deploys are `eidan deploy` from your eidan checkout
(see [DEPLOYMENT.md](./DEPLOYMENT.md) §4).

## Prerequisites

- Fly account + `flyctl` (`brew install flyctl` then `fly auth login`).
- Vercel account (for the frontend — see
  [DEPLOY_FRONTEND](./DEPLOY_FRONTEND.md)).
- A domain you control. **Load-bearing** — read §3 below before
  picking it.

Estimated monthly cost: Fly machine on the always-on plan ~$5/mo,
Fly Postgres ~$5/mo (1GB), Vercel hobby free. ~$10/mo all-in.

## 1. Create the Fly app

```bash
fly apps create eidan-api --org personal
# 'eidan-api' must match the `app:` field on the Fly node in topology.yml
```

`fly postgres attach` (if you use it below) needs the target app to
exist first.

## 2. Postgres

Pick one.

### Option A — bring your own (Supabase / Neon / RDS / …)

`database_url:` in `topology.yml` becomes your provider's connection
string under the `postgresql+asyncpg://` scheme. For managed
providers that require TLS, append `?ssl=require`:

```
postgresql+asyncpg://<user>:<password>@<host>:5432/<db>?ssl=require
```

### Option B — Fly-managed Postgres

```bash
fly postgres create --name eidan-pg --org personal --region lhr \
  --vm-size shared-cpu-1x --volume-size 1
fly postgres attach --app eidan-api eidan-pg
```

`fly postgres attach` writes `DATABASE_URL` as a Fly secret using
the `postgres://` scheme. eidan needs `postgresql+asyncpg://`. Read
the URL back from inside a running machine and re-set it under the
right scheme:

```bash
# Pull the attached URL from inside the machine. Fly masks the
# value in `fly secrets list` but exposes it as an env var to
# the running process.
fly ssh console --app eidan-api -C 'printenv DATABASE_URL'
# → postgres://<user>:<password>@<host>:5432/<db>?sslmode=disable

# Re-set with the asyncpg scheme. Strip ?sslmode=disable —
# asyncpg uses different TLS knobs.
fly secrets set --app eidan-api \
  DATABASE_URL='postgresql+asyncpg://<user>:<password>@<host>:5432/<db>'
```

(Once your topology is wired up, `eidan deploy --tags secrets`
takes over this step.)

## 3. Custom domain (load-bearing)

The verify endpoint sets `eidan_refresh` as an `httpOnly;
SameSite=Lax` cookie scoped to `/api/auth/refresh`. That cookie is
what keeps the session alive across access-token expiries — without
it, the SPA falls back to a fresh magic-link round-trip on every
reload.

`SameSite=Lax` requires the request triggering the cookie's send to
be **same-site** with the cookie's origin. "Same-site" here is the
**registrable domain** (eTLD+1), not the hostname:

| Frontend host         | Backend host             | Cookie sent? |
|-----------------------|--------------------------|--------------|
| `app.example.com`     | `api.example.com`        | yes — same registrable domain (`example.com`) |
| `example.com`         | `api.example.com`        | yes |
| `app.example.com`     | `eidan-api.fly.dev`      | **no — third-party, browser drops `Set-Cookie`** |
| `app.example.com`     | `api.other-tld.dev`      | **no — different registrable domain** |

Practical consequence: **before you pick a frontend domain, pick a
backend custom domain that shares its registrable domain.**

```bash
fly certs create --app eidan-api api.yourdomain.com
# Add the A + AAAA records Fly prints, wait for "Issued".
```

Then set `NEXT_PUBLIC_EIDAN_BACKEND_URL=https://api.yourdomain.com`
on Vercel and add the frontend origin to `cors_origins:` on the
Fly node in `topology.yml`:

```yaml
nodes:
  fly-prod:
    target: fly
    app: eidan-api
    region: lhr
    cors_origins:
      - https://app.yourdomain.com    # exact origin, NO trailing slash
      - https://www.yourdomain.com    # add each origin you serve from
```

The browser sends `Origin: https://app.yourdomain.com` (no
trailing slash, per RFC 6454). The backend's CORS middleware
does a literal compare, so `https://app.yourdomain.com/` (with
slash) would never match — `eidan deploy` strips trailing
slashes at the render boundary as a safety net, but topology
entries should be written without them.

`eidan init` prompts for these origins in the wizard. Adding /
removing later is a topology edit + `eidan deploy --node
fly-prod --tags deploy`.

**Diagnosing CORS failures.** Browser console reports something
like:

```
Access to fetch at 'https://api.example.com/api/auth/config'
from origin 'https://app.example.com' has been blocked by CORS
policy: No 'Access-Control-Allow-Origin' header is present on
the requested resource.
```

The signal is in the OPTIONS preflight:

```bash
curl -sS -i -X OPTIONS \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: GET" \
  https://api.example.com/api/auth/config
```

A 200 with `access-control-allow-origin: https://app.example.com`
means the backend accepts the origin. A 400 with `Disallowed
CORS origin` means it doesn't — the origin string (after the
slash-strip safety net) doesn't match what's in `cors_origins:`.

`SameSite=None; Secure` would also paper over a
cross-registrable-domain shape, but it's the dead-man-walking
option: Safari ITP blocks it, Brave blocks it by default, Chrome's
third-party cookie deprecation kills it on the rest. The
custom-domain shape is the only path that keeps working.

## 4. Initial migrations

Run once after the first `eidan deploy`. `eidan admin db migrate`
runs core then iterates each installed plugin's private-schema
migrations:

```bash
fly ssh console --app eidan-api -C 'uv run eidan admin db migrate'
```

Skip if another node (the Pi, a laptop bootstrap) has already
migrated this Postgres — alembic is version-tracked, a re-run is a
no-op.

## 5. Hand off to the CLI

From your laptop, inside the eidan checkout:

```bash
eidan deploy --node fly-prod
```

This is the line that pushes secrets, renders fly.toml, assembles
a local build context (eidan core + the bundle plugins resolved
from operator-local sibling repos), runs `fly deploy` against
that context, and rolls the machines. Plugins ride the image; no
SSH install step, no PAT on the machine. From here forward, every
change is a `topology.yml` edit + `eidan deploy`.

**Paid bundles**: clone the bundle repos as siblings of your
eidan checkout (e.g. `~/Documents/GitHub/eidan-pro/` next to
`~/Documents/GitHub/eidan/`). The CLI finds them via the
conventional sibling layout. Override with `EIDAN_BUNDLE_ROOT=<path>`
if your bundles are elsewhere (CI, separate drive).

## Smoke-check

```bash
curl https://api.yourdomain.com/api/auth/config
# Expect {"provider":"native", ...}
```

## Sentry tick on Fly

`sentry.enabled` defaults to `false` on Fly because the 5-minute
tick would burn LLM cost on every auto-stop machine. Opt in
per-node via `sentry: { enabled: true }` if the Fly app is your
primary long-lived node and there's no Pi running the tick.

## Optional: CI deploy

Run CI from a fork of eidan (or any private repo where you commit
the vault-encrypted topology under `.eidan/`). This repo
intentionally does not ship `.github/workflows/` deploy entries —
the public mirror should not carry CI that talks to someone else's
Fly account.

```yaml
# .github/workflows/deploy.yml in your eidan fork (or wherever).
# Repo layout assumed:
#   ./.eidan/topology.yml   ← vault-encrypted, committed
#   ./apps/cli/             ← upstream eidan tree (this fork)
name: Deploy
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency: { group: eidan-deploy, cancel-in-progress: false }
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - uses: superfly/flyctl-actions/setup-flyctl@1.5
      - run: uv tool install --from ./apps/cli eidan-cli
      - run: |
          echo "$VAULT_PASS" > .eidan/.vault-pass
          chmod 0600 .eidan/.vault-pass
          eidan deploy --node fly-prod
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
          VAULT_PASS:    ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
```

Generate the Fly token with `fly tokens create deploy`. Pin actions
to a commit SHA for production; the `@1.5` tag above is shown for
brevity.

## `infra/fly/` artefacts

`infra/fly/Dockerfile` is the canonical image build path — the
CLI uses it as the Dockerfile for every `fly deploy`. The CLI
assembles its build context next to your eidan checkout in
`.eidan-runtime/<node>/build-context/`, then runs `fly deploy
--dockerfile <ctx>/infra/fly/Dockerfile <ctx>`.

`infra/fly/fly.toml.example` stays as a reference for operators
who want to inspect the rendered shape without running the CLI.
The CLI doesn't read it — the live render comes from
`apps/cli/eidan_cli/playbooks/fly/fly.toml.template`.
