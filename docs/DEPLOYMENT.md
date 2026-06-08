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

`eidan-cli` isn't on PyPI yet — install via the bootstrap script
in your eidan checkout. Requires [`uv`](https://astral.sh/uv):

```bash
# Once, anywhere — installs uv to ~/.local/bin
curl -LsSf https://astral.sh/uv/install.sh | sh

# Clone eidan and run the bootstrap script
git clone https://github.com/sielay/eidan.git && cd eidan
./scripts/bootstrap.sh
```

`bootstrap.sh` does two things:

1. **Configures git's `core.hooksPath`** to the tracked
   `.githooks/` directory. After every `git pull` that touches
   `apps/cli/`, the post-merge hook auto-runs
   `uv tool install --reinstall` so your `eidan` command stays
   in sync with upstream. You don't have to remember.
2. **Runs the initial `uv tool install`** so `eidan` lands at
   `~/.local/bin/eidan` immediately.

Also needed on the laptop running deploys:

- **`ansible-core` + `ansible.posix` collection** (for Pi targets):
  `uv tool install ansible-core` then `ansible-galaxy collection
  install ansible.posix`. The Pi reconcile rsyncs the eidan tree
  from your laptop via `ansible.posix.synchronize`.
- **`rsync`** (for Pi targets) — universal on macOS / Linux, but
  worth verifying with `which rsync`.
- **`flyctl`** (for Fly targets) — `brew install flyctl && fly auth login`
- **Docker** (for Fly targets without a pinned `image:`) — Docker
  Desktop / colima / Rancher / whatever. The reconciler builds
  the image locally from a pre-assembled context (your eidan
  checkout + bundle plugins resolved from operator-local sibling
  repos). Skip if you pin `image:` in topology to a tag you've
  already published yourself.

The CLI probes for the right one before any deploy fires; you'll
see a friendly "install X" message if a target needs a tool that
isn't on PATH.

> **Future:** when `eidan-cli` ships to PyPI you'll be able to
> `pipx install eidan-cli` and skip the clone. The git path stays
> as a supported fallback for air-gapped / no-PyPI environments.

## 2. Scaffold + topology.yml

From inside your eidan checkout:

```bash
eidan init        # interactive wizard (recommended)
```

The wizard walks you through node setup field-by-field (target,
SSH details for Pi or app+region for Fly, database URL, provider,
bundles) and writes `.eidan/topology.yml` with a freshly minted
`auth_master_key` (displayed once at the end — record it offline).

You get a starter set under `.eidan/`:

| File | Purpose |
|---|---|
| `.eidan/topology.yml` | Source of truth — every node, every env knob. |
| `.eidan/.gitignore` | Belt-and-braces; the parent `.eidan/` is already gitignored at the eidan repo root. |
| `.eidan/.vault-pass.example` | Copy to `.eidan/.vault-pass`, edit, `chmod 0600`. |
| `.eidan/README.md` | Operator notes template. |

Hand-edited starting shape (if you skip the wizard with `eidan init --here`):

```yaml
schema: 1

defaults:
  # `image:` unset → reconciler builds from infra/fly/Dockerfile
  # against an assembled context (eidan tree + bundle plugins).
  # Pin it (e.g. ghcr.io/myorg/eidan:v0.1.0) if you've published
  # your own image and want to skip the local build.
  provider:
    name: anthropic
    default_model: claude-sonnet-4-6

nodes:
  raspberry:
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

`bundles:` resolves against operator-local sibling repos: each
entry expects `<eidan-parent>/<bundle-name>/` to be a clone of
the bundle repo with the plugin subdirs you want to bake in.
Override the parent with `EIDAN_BUNDLE_ROOT=<path>` if your
checkouts live elsewhere. No GitHub PAT on remote machines — the
trust boundary is your laptop.

The master key the wizard mints (or that you generate by hand with
`python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`)
must appear on every node sharing one Postgres — back it up
out-of-band (1Password / paper).

Vault-encrypt the sensitive scalars (`auth_master_key`,
`database_url`, provider `api_key`):

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
eidan deploy --node raspberry
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

- assembles a build context in `.eidan-runtime/<node>/build-context/`
  (eidan tree + bundle plugins resolved from operator-local sibling
  repos), then `fly deploy --dockerfile <ctx>/infra/fly/Dockerfile
  <ctx>`. Default. Needs Docker on your laptop or Fly's remote
  builder. **Plugins ride the image** — no SSH install step.
- pulls a pinned image (`image: ghcr.io/myorg/eidan:v0.1.0` set on
  the node), via `fly deploy --image …`. No build needed.

## 5. Update

Updating happens through the same `eidan deploy` command — the CLI
is idempotent, so re-running reconciles whatever drifted:

```bash
eidan deploy                              # everything
eidan deploy --node raspberry                 # one node
eidan deploy --node raspberry --tags env      # just env / unit
eidan deploy --node raspberry --tags source   # just code re-sync
eidan deploy --node raspberry --dry-run       # show planned changes
```

To bump a release: `git pull` your eidan checkout — the tracked
post-merge hook (wired by `./scripts/bootstrap.sh`) auto-runs
`uv tool install --reinstall` if `apps/cli/` changed, so your
`eidan` command stays in sync. Then `eidan deploy` — the Fly
reconciler rebuilds the image with the new code, the Pi
reconciler rsyncs the new tree from your laptop. No manual
updates on the remote machine.

## 6. Plugins

Bundles are declared in the topology and baked into the image (Fly)
or rsynced onto the Pi (Pi) on every deploy:

```yaml
nodes:
  raspberry:
    bundles: [eidan-pro, eidan-sage]
    disable: [imap]          # baked but loader skips it on this node
```

Or via the CLI mutators (which round-trip the YAML preserving
comments):

```bash
eidan plugin disable imap --node raspberry
eidan plugin enable  imap --node raspberry
eidan deploy --node raspberry
```

Changing the bundle set is a rebuild + redeploy. No in-place
plugin install at runtime — the trade-off for keeping PATs off
remote machines and avoiding multi-machine drift.

Inspect the topology any time:

```bash
eidan node list                # one row per node
eidan node show raspberry          # resolved view, defaults merged
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
