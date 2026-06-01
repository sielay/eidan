# Pi bootstrap

One-time setup on a fresh Raspberry Pi so `eidan deploy --node <name>`
from your laptop has a working host to reconcile against. Per Pi,
once; subsequent deploys are `eidan deploy` from your eidan
checkout (see [DEPLOYMENT.md](./DEPLOYMENT.md) §3).

## Prerequisites

- Raspberry Pi 4 or 5 with **4GB+ RAM**, **Debian Bookworm 64-bit**
  (Raspberry Pi OS Lite recommended), reachable over SSH.
- A domain you control if you plan to use the Vercel frontend with
  a custom domain. Optional if you'll only hit the API directly.
- Optional: SMTP credentials (Fastmail, Postmark, Mailgun, …) so
  magic-link emails actually leave the box. Without them the link
  is still logged to journald.

## 1. Create the service user + deploy dirs

```bash
sudo useradd -r -s /bin/bash -d /home/eidan -m eidan
sudo mkdir -p /etc/eidan
```

`/opt/eidan` is created on first `eidan deploy` (the playbook
rsyncs your laptop's eidan tree into it); only `/etc/eidan` and
the `eidan` user need to exist before then.

## 2. Install system deps + uv

```bash
sudo apt update && sudo apt install -y rsync curl
sudo -u eidan bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'
sudo -u eidan /home/eidan/.local/bin/uv python install 3.12
```

`rsync` is what the deploy uses to push the eidan tree from your
laptop. Raspberry Pi OS / Debian Bookworm ships Python 3.11 and
does **not** carry `python3.12` in its default apt repos. eidan
only requires `>=3.11`, but letting `uv` manage the interpreter
avoids version drift across Pi vs. Fly.

### Laptop-side prerequisite: `ansible.posix` collection

The playbook uses `ansible.posix.synchronize` (rsync over SSH).
The `ansible` (full distribution) package ships it by default;
operators on `ansible-core` install it once:

```bash
ansible-galaxy collection install ansible.posix
```

## 3. Install Ollama + pull the sentry model

Ollama is the Pi's own LLM. The installer creates an `ollama`
system user, drops a `systemd` unit, and exposes the
OpenAI-compatible endpoint on `http://127.0.0.1:11434/v1`.

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
ollama pull phi3
```

Smoke-check:

```bash
curl http://127.0.0.1:11434/api/tags          # should list phi3
ollama run phi3 "say hi in one word"
```

`phi3` (3.8B Q4) fits comfortably in 4GB RAM. Swap for a heavier
model (`ollama pull mistral`, `ollama pull llama3.1:8b`) only if
you have 8GB+ headroom.

The eidan systemd unit declares `After=ollama.service` so Ollama is
up before eidan tries to call it.

## 4. Postgres

Pick one.

### Option A — Postgres on the Pi

Simplest, but the Pi becomes a single point of failure for both
compute and data:

```bash
sudo apt install -y postgresql
sudo -u postgres psql <<'SQL'
  CREATE ROLE eidan_app LOGIN PASSWORD 'CHANGE-ME-STRONG';
  CREATE DATABASE eidan OWNER eidan_app;
SQL
```

`database_url:` in `topology.yml` will be:
`postgresql+asyncpg://eidan_app:CHANGE-ME-STRONG@127.0.0.1:5432/eidan`

Back this up nightly (e.g. `pg_dump | rclone` to external storage).

### Option B — Supabase Postgres

Recommended once you want off-box backups and a UI for inspection.

1. Supabase dashboard → **New project**. Pick a region near you.
   Record the DB password.
2. **Settings → Database → Connection string → URI (direct, port
   5432, NOT the pooler)**. Copy it.
3. `database_url:` will be
   `postgresql+asyncpg://postgres:<dbpw>@<host>:5432/postgres`.

You can swap to a dedicated `eidan_app` role later via
`EIDAN_CREATE_APP_ROLE=true` on the first migration run (see §5
below).

## 5. Auth master key

Generate it once and **record it offline** — you'll set the same
value on every backend host that joins this deployment, so the JWT
keypair stored in `eidan.auth_keypair` is decipherable from every
node:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Put it in your laptop-side `topology.yml` as `auth_master_key:` on
this node.

> **Joining an existing deployment?** The migration runs on every
> `eidan deploy`, but Alembic is version-tracked — a re-run on an
> already-migrated DB is a no-op.

The rsync of your laptop's eidan tree onto `/opt/eidan`, the
`uv sync`, and `eidan admin db migrate` are all run by the
Ansible playbook on every `eidan deploy --node <name>` (see §7).
You don't run them by hand.

**Paid bundles**: clone the bundle repos as siblings of your
eidan checkout (e.g. `~/Documents/GitHub/eidan-pro/` next to
`~/Documents/GitHub/eidan/`). The CLI finds them via the
sibling layout and ships them to the Pi alongside the eidan
tree — no PAT lives on the Pi. Override with
`EIDAN_BUNDLE_ROOT=<path>` if your bundles are elsewhere.

For Supabase + a dedicated app role, set
`EIDAN_CREATE_APP_ROLE=true` and `EIDAN_APP_DB_PASSWORD=<strong>`
in `/etc/eidan/eidan.env` before the first deploy (or pass them via
`-e` to the playbook). Subsequent deploys can drop those keys.

After the first deploy, verify `eidan.conversations`,
`eidan.messages`, and `eidan.auth_keypair` exist via `psql` or
Supabase Studio. The `auth_keypair` row is minted lazily on first
backend boot.

## 6. Persistent journald (Pi-specific)

Raspberry Pi OS pins journald to RAM-only storage by default
(`/usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf`) to
spare the SD card. With that default, `journalctl -u eidan-backend`
shows nothing from before the most recent boot — including the
minutes leading up to whatever made you reboot. Override once:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/persistent.conf >/dev/null <<'EOF'
[Journal]
Storage=persistent
EOF
sudo systemctl restart systemd-journald
sudo journalctl --flush
```

Verify:

```bash
ls /var/log/journal/$(cat /etc/machine-id)/   # non-empty
sudo journalctl --list-boots                  # grows across reboots
```

Capped at journald's default `SystemMaxUse=200M`. SD-card wear is
not a concern at that volume on modern cards.

## 7. Hand off to the CLI

From your laptop, inside the eidan checkout:

```bash
eidan deploy --node <pi-node>
```

This is the line that installs the systemd unit, renders the env
file, installs declared bundles, and starts the service. From here
forward, every change is a `topology.yml` edit + `eidan deploy`.

## Smoke-check

After the first `eidan deploy`, watch journald on the Pi for:

- `[bootstrap] behaviour dispatcher started with N cron job(s)` —
  Sentry's tick schedule registered.
- `[provider] ollama @ http://127.0.0.1:11434/v1 default_model=phi3` —
  the host wired itself to Ollama.

From the laptop:

```bash
curl http://<pi-host>:8000/api/auth/config
# Expect {"provider":"native", ...}
```

## Sentry tick — what's actually running

Sentry is a `tier: core` plugin enabled by default. Phase 1 ships
deterministic detectors only (overdue commitments, long-silence
gaps, scope-drift checks). Three hand-coded SQL/threshold checks
run on the `PT5M` schedule and write:

- one summary row per tick to `plugin_sentry.sentry_ticks`,
- one row per detected pattern to `plugin_sentry.sentry_nudges`,
- one row to `eidan.escalations` when a pattern crosses the
  escalation threshold or a nudge delivery fails.

**No LLM call yet.** The Phi-3 open-ended pattern matcher described
in [SENTRY_FEATURE_SPEC.md](./SENTRY_FEATURE_SPEC.md) lands with the
local-model adapter. Until then, `provider.default_model: phi3` is
used by the foreground agent but not by Sentry.

Confirm the tick is firing:

```bash
journalctl -u eidan-backend | grep sentry
```

Pause via `disable: [sentry]` on the node in `topology.yml` +
`eidan deploy --node <name>`.

## Updating the Pi codebase

`eidan deploy` reconciles **everything** — including the
`/opt/eidan` tree. On every run the CLI assembles a build context
on your laptop (eidan core + the bundle plugins resolved from
operator-local sibling repos), rsyncs it to `/opt/eidan` (with
`--delete`, excluding `.venv` so the Pi-side venv survives),
re-runs `uv sync` when the tree moved, runs `eidan admin db
migrate`, and restarts the service if any of those changed.

The rsync uses `--delete` semantics: files removed from your
laptop's eidan tree get removed from `/opt/eidan` on the next
deploy. Hand-edits inside `/opt/eidan` will be wiped — make
changes on your laptop and re-deploy.

Most eidan migrations are *additive* (new tables / columns /
indexes) — the running service ignores them. For *destructive*
migrations (drop column, rename table, changed CHECK constraint)
stop the service first; release notes flag which migrations are
destructive.
