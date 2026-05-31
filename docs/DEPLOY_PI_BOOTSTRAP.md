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
sudo mkdir -p /opt/eidan /etc/eidan
sudo chown eidan:eidan /opt/eidan
```

## 2. Install system deps + uv

```bash
sudo apt update && sudo apt install -y git curl
sudo -u eidan bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'
sudo -u eidan /home/eidan/.local/bin/uv python install 3.12
```

Raspberry Pi OS / Debian Bookworm ships Python 3.11 and does **not**
carry `python3.12` in its default apt repos. eidan only requires
`>=3.11`, but letting `uv` manage the interpreter avoids version
drift across Pi vs. Fly.

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

## 5. Clone + sync the repo, run initial migrations

From the Pi (so the venv is built as `eidan` with `eidan`'s `uv`):

```bash
sudo -u eidan git clone https://github.com/sielay/eidan.git /opt/eidan
sudo -u eidan git -C /opt/eidan checkout v0.1.0   # pin to a tag, not main
sudo -u eidan /home/eidan/.local/bin/uv --directory /opt/eidan sync --no-dev
```

Generate the auth master key — **record it offline**, you'll set the
same value on every backend host that joins this deployment:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

> **Joining an existing deployment?** If another node has already
> migrated this Postgres, **skip the migration step below.**
> Alembic is version-tracked; a re-run is a no-op, but skipping
> avoids the `EIDAN_CREATE_APP_ROLE` handling.

Run migrations. `eidan admin db migrate` runs core then iterates
each installed plugin's private-schema migrations:

```bash
sudo -u eidan bash -lc '
  DATABASE_URL="postgresql+asyncpg://eidan_app:CHANGE-ME@127.0.0.1:5432/eidan" \
  EIDAN_AUTH_MASTER_KEY="<the-key-you-just-generated>" \
  /home/eidan/.local/bin/uv --directory /opt/eidan run \
    eidan admin db migrate
'
```

For Supabase + a dedicated app role, prepend
`EIDAN_CREATE_APP_ROLE=true EIDAN_APP_DB_PASSWORD="<strong>"`.

Verify `eidan.conversations`, `eidan.messages`, and
`eidan.auth_keypair` exist via `psql` or Supabase Studio. The
`auth_keypair` row is minted lazily on first backend boot.

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

`eidan deploy` reconciles env / unit / plugins, but the upstream
`/opt/eidan` checkout is bumped manually (the playbook doesn't `git
pull` for you — that's release-policy territory):

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

Most eidan migrations are *additive* (new tables / columns /
indexes) — the running service ignores them. For *destructive*
migrations (drop column, rename table, changed CHECK constraint)
stop the service first; release notes flag which migrations are
destructive.
