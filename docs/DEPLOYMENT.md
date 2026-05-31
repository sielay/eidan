# Deployment

Six steps. Everything happens from your eidan clone.

```bash
# 1. Install uv (if you don't have it)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Clone eidan and install the CLI
git clone https://github.com/sielay/eidan.git
cd eidan
uv tool install --from ./apps/cli eidan-cli

# 3. Scaffold deploy config into .eidan/ (gitignored)
eidan init --here

# 4. Edit topology.yml + vault-encrypt secrets
$EDITOR .eidan/topology.yml
cp .eidan/.vault-pass.example .eidan/.vault-pass && chmod 0600 .eidan/.vault-pass

# 5. Per-Pi bootstrap (once per Pi) — see DEPLOY_PI_BOOTSTRAP.md
#    Per-Fly bootstrap (once per Fly app) — see DEPLOY_FLY_BOOTSTRAP.md

# 6. Deploy
eidan deploy
```

Everything operator-private lives in `.eidan/` inside your eidan
checkout. `.eidan/` is gitignored at the repo root, so a `git pull`
of upstream eidan never touches your topology, your secrets, or
your runtime state. You don't need a separate ops repo.

This document is **only** the happy path. Bootstrap (one-time
setup per Pi / Fly app), reference material (auth, observability),
and the distributed-topology recipe live in the supporting docs at
the bottom.

---

## 1. Install eidan-cli

`eidan-cli` isn't on PyPI yet — install from your eidan checkout
via `uv tool install`. Requires [`uv`](https://astral.sh/uv):

```bash
# Once, anywhere — installs uv to ~/.local/bin
curl -LsSf https://astral.sh/uv/install.sh | sh

# Then clone eidan and install the CLI globally
git clone https://github.com/sielay/eidan.git
cd eidan
uv tool install --from ./apps/cli eidan-cli
```

The `eidan` binary lands in `~/.local/bin/eidan`. Upgrade with:

```bash
cd eidan && git pull
uv tool install --reinstall --from ./apps/cli eidan-cli
```

Also needed on the laptop running deploys:

- **`ansible-core`** (for Pi targets) — `uv tool install ansible-core`
- **`flyctl`** (for Fly targets) — `brew install flyctl && fly auth login`
- **Docker** (for Fly targets without a pinned `image:`) — Docker
  Desktop / colima / Rancher / whatever. The reconciler builds
  the image locally from `infra/fly/Dockerfile`. Skip if you pin
  `image:` in topology to a tag you've already published yourself.

The CLI probes for the right one before any deploy fires; you'll
see a friendly "install X" message if a target needs a tool that
isn't on PATH.

> **Future:** when `eidan-cli` ships to PyPI you'll be able to
> `pipx install eidan-cli` and skip the clone. The git path stays
> as a supported fallback for air-gapped / no-PyPI environments.

## 2. Scaffold + topology.yml

From inside your eidan checkout:

```bash
eidan init --here
```

You get a starter set under `.eidan/`:

| File | Purpose |
|---|---|
| `.eidan/topology.yml` | Source of truth — every node, every env knob. |
| `.eidan/.gitignore` | Belt-and-braces; the parent `.eidan/` is already gitignored at the eidan repo root. |
| `.eidan/.vault-pass.example` | Copy to `.eidan/.vault-pass`, edit, `chmod 0600`. |
| `.eidan/README.md` | Operator notes template. |

Edit `.eidan/topology.yml`. Minimum shape:

```yaml
schema: 1

defaults:
  plugin_source: gh:sielay
  github_token: REPLACE-OR-VAULT-ENCRYPT
  # `image:` unset → reconciler builds from infra/fly/Dockerfile.
  # Pin it (e.g. ghcr.io/myorg/eidan:v0.1.0) if you've published
  # your own image and want to skip the local build.
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
cp .eidan/.vault-pass.example .eidan/.vault-pass && chmod 0600 .eidan/.vault-pass
ansible-vault encrypt_string --vault-id default@.eidan/.vault-pass \
  'sk-ant-...' --name 'api_key'
# paste the !vault |... block under provider.api_key in .eidan/topology.yml
```

The full schema with every field is at
[packages/schemas/schemas/core/deploy/Topology.schema.json](../packages/schemas/schemas/core/deploy/Topology.schema.json).

> **Prefer a separate ops repo?** Pass a name instead of `--here`:
> `eidan init my-deployment` creates a sibling directory you can
> manage as its own private git repo. Same template, different
> location.

## 3. Deploy to a Pi

One-time per Pi: see [DEPLOY_PI_BOOTSTRAP](./DEPLOY_PI_BOOTSTRAP.md)
to create the service user, install `uv`, install Ollama, install
Postgres (or point at Supabase), clone the repo, and run the
initial migration.

Then, from your eidan checkout:

```bash
eidan deploy --node kasha
```

The CLI auto-discovers `.eidan/topology.yml`, ssh's into the Pi,
renders `/etc/eidan/eidan.env` and the systemd unit, installs
declared bundles, restarts the service.

## 4. Deploy to Fly

One-time per Fly app: see [DEPLOY_FLY_BOOTSTRAP](./DEPLOY_FLY_BOOTSTRAP.md)
to create the Fly app, provision Postgres, and wire the custom
domain.

Then:

```bash
eidan deploy --node fly-prod
```

The CLI renders a per-deploy `fly.toml`, pushes secrets via `fly
secrets set`, and either:

- builds from `infra/fly/Dockerfile` in your checkout (default — no
  `image:` set), via `fly deploy --dockerfile … <eidan>`. Needs
  Docker on your laptop or Fly's remote builder.
- pulls a pinned image (`image: ghcr.io/myorg/eidan:v0.1.0` set on
  the node), via `fly deploy --image …`. No build needed.

Then ssh's in to install declared bundles.

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

To bump a release: `git pull` your eidan checkout to a new tag,
re-deploy. The Fly reconciler picks up the new Dockerfile / image
automatically; the Pi reconciler still needs you to update
`/opt/eidan/` on the Pi itself (see
[DEPLOY_PI_BOOTSTRAP §7](./DEPLOY_PI_BOOTSTRAP.md) — the codebase
update flow there).

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
