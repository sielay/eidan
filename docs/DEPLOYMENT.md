# Deployment

Six steps. The `eidan deploy` CLI owns the whole flow.

```bash
pipx install eidan-cli                 # install
eidan init my-deployment && cd $_      # scaffold ops repo
$EDITOR topology.yml                   # add your nodes + secrets (vault-encrypt)
eidan deploy                           # reconcile every node
```

Each node in `topology.yml` declares a `target:` — `pi`, `fly`, or `docker` (the last is a follow-up). The CLI renders the env file / `fly.toml` / systemd unit, pushes secrets, deploys the image, and installs declared bundles. You don't write any of those files by hand.

This document is **only** the happy path. Bootstrap (one-time setup
per Pi / Fly app), reference material (auth, observability), and
the distributed-topology recipe live in the supporting docs at the
bottom.

---

## 1. Install eidan-cli

```bash
pipx install eidan-cli
# or: pip install --user eidan-cli
```

Also needed on the laptop running deploys:

- **`ansible-core`** (for Pi targets) — `pipx install ansible-core`
- **`flyctl`** (for Fly targets) — `brew install flyctl && fly auth login`

The CLI probes for the right one before any deploy fires; you'll
see a friendly "install X" message if a target needs a tool that
isn't on PATH.

## 2. Scaffold + topology.yml

```bash
eidan init my-deployment
cd my-deployment
```

You get a private ops repo with:

| File | Purpose |
|---|---|
| `topology.yml` | Source of truth — every node, every env knob. |
| `.gitignore` | Excludes `.vault-pass` + ephemeral runtime files. |
| `.vault-pass.example` | Copy to `.vault-pass`, edit, `chmod 0600`. |
| `README.md` | Operator notes template. |

Edit `topology.yml`. Minimum shape:

```yaml
schema: 1

defaults:
  plugin_source: gh:sielay
  github_token: REPLACE-OR-VAULT-ENCRYPT
  image: ghcr.io/sielay/eidan:v0.1.0          # pin once, roll forward deliberately
  provider:
    name: anthropic
    default_model: claude-sonnet-4-6

nodes:
  kasha:
    target: pi
    host: 192.168.1.100
    ssh_user: pi
    database_url: postgresql+asyncpg://eidan:eidan@127.0.0.1:5432/eidan
    auth_master_key: REPLACE-WITH-secrets.token_urlsafe-48
    auth_allowed_email: you@yourdomain.com
    provider: { name: ollama, default_model: phi3 }
    bundles: [eidan-pro]

  fly-prod:
    target: fly
    app: eidan-api
    region: lhr
    database_url: postgresql+asyncpg://...
    auth_master_key: REPLACE-WITH-secrets.token_urlsafe-48
    auth_allowed_email: you@yourdomain.com
    bundles: [eidan-pro]
```

Generate the master key once with
`python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`. The
**same value** must appear on every node sharing one Postgres — back
it up out-of-band (1Password / paper).

Vault-encrypt the sensitive scalars (`auth_master_key`,
`database_url`, `github_token`, provider `api_key`):

```bash
cp .vault-pass.example .vault-pass && chmod 0600 .vault-pass
ansible-vault encrypt_string --vault-id default@.vault-pass \
  'sk-ant-...' --name 'api_key'
# paste the !vault |... block under provider.api_key in topology.yml
```

Commit (with vault layer in place) and push to a private remote:

```bash
git init && git add . && git commit -m "initial topology"
git remote add origin git@github.com:<you>/<my-deployment>.git
git push -u origin main
```

The full schema with every field is at
[packages/schemas/schemas/core/deploy/Topology.schema.json](../packages/schemas/schemas/core/deploy/Topology.schema.json).

## 3. Deploy to a Pi

One-time per Pi: see [DEPLOY_PI_BOOTSTRAP](./DEPLOY_PI_BOOTSTRAP.md)
to create the service user, install `uv`, install Ollama, install
Postgres (or point at Supabase), clone the repo, and run the
initial migration.

Then, from your ops repo on the laptop:

```bash
eidan deploy --node kasha
```

The CLI ssh's in, renders `/etc/eidan/eidan.env` and the systemd
unit from `topology.yml`, installs declared bundles, restarts the
service.

## 4. Deploy to Fly

One-time per Fly app: see [DEPLOY_FLY_BOOTSTRAP](./DEPLOY_FLY_BOOTSTRAP.md)
to create the Fly app, provision Postgres, and wire the custom
domain.

Then:

```bash
eidan deploy --node fly-prod
```

The CLI renders a per-deploy `fly.toml`, pushes secrets via `fly
secrets set`, runs `fly deploy --image <topology.image>`, and ssh's
in to install declared bundles.

## 5. Update

Updating happens through the same `eidan deploy` command — the CLI
is idempotent, so re-running reconciles whatever drifted:

```bash
eidan deploy                              # everything
eidan deploy --node kasha                 # one node
eidan deploy --node kasha --tags env      # just env / unit
eidan deploy --node kasha --tags plugins  # just plugin install
eidan deploy --node kasha --dry-run       # show planned changes
```

To bump a release: edit `defaults.image:` (or the per-node `image:`)
in `topology.yml`, commit, `eidan deploy`. Migrations run via
`eidan admin db migrate` on the target host once; the release
notes flag any destructive migrations that need a stop-the-service
window.

## 6. Plugins

Bundles are declared in the topology and installed via reconcile:

```yaml
nodes:
  kasha:
    bundles: [eidan-pro, eidan-sage]
    disable: [imap]          # installed but loader skips it on this node
```

Or via the CLI mutators (which round-trip the YAML preserving
comments):

```bash
eidan plugin disable imap --node kasha
eidan plugin enable  imap --node kasha
eidan deploy --node kasha --tags plugins,restart
```

Inspect the topology any time:

```bash
eidan node list                # one row per node
eidan node show kasha          # resolved view, defaults merged
```

---

## Supporting docs (fine print)

- **[DEPLOY_PI_BOOTSTRAP](./DEPLOY_PI_BOOTSTRAP.md)** — one-time
  Pi setup: service user, uv, Ollama, Postgres, journald tweak,
  smoke-check.
- **[DEPLOY_FLY_BOOTSTRAP](./DEPLOY_FLY_BOOTSTRAP.md)** — one-time
  Fly setup: account, app create, Postgres options, custom domain
  (load-bearing for the refresh cookie).
- **[DEPLOY_FRONTEND](./DEPLOY_FRONTEND.md)** — Vercel project
  setup for the Next.js UI.
- **[DEPLOY_DISTRIBUTED](./DEPLOY_DISTRIBUTED.md)** — multi-node
  topology (Fly API + Pi worker + shared Postgres).
- **[011_AUTH_FLOW](./011_AUTH_FLOW.md)** — native magic-link auth
  internals; only need to read if you're customising the flow.
- **[024_NODE_TELEMETRY](./024_NODE_TELEMETRY.md)** — per-node
  heartbeats + event stream + external log forwarding
  (BetterStack / Datadog / Axiom / Loki).
- **[012_SECRETS](./012_SECRETS.md)** — the vault model + the
  master-key rotation runbook.

`eidan-cli` is the single source of truth for the deploy surface;
everything below it is implementation detail or one-shot setup the
operator does once.
