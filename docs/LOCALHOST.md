# Localhost setup

The end-to-end "I just want to talk to my agent" path. Takes ~10
minutes via the dev container, ~15 minutes bare-metal. Targets
macOS + Linux; Windows works via WSL2.

The condensed version lives in the [README](../README.md#quick-start);
this is the version with vendor screens, troubleshooting, and the
bare-metal walkthrough.

## Quickstart via devcontainer (recommended)

If you have Docker + VS Code (or another devcontainer-aware editor
like JetBrains Gateway or the `devcontainer` CLI), the fastest path
skips §0, §1, and §4 of this doc — Python, `uv`, `psql`, Node,
Postgres, and a Caddy reverse proxy come prewired.

The default dev container brings up three services on its compose
network:

- **`app`** — Python + Node + the dev tools. `make dev` runs here.
- **`db`** — Postgres 16 sidecar. `eidan.*` lives here.
- **`proxy`** — Caddy. Listens on the host's `:3000` and routes
  `/api/*` to the backend, everything else to Next.js, so the
  browser sees a single origin.

1. Clone the repo and `cp .env.example .env`.
2. Fill in three values:
   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   EIDAN_AUTH_MASTER_KEY=$(python -c "import secrets; print(secrets.token_urlsafe(48))")
   EIDAN_AUTH_ALLOWED_EMAIL=you@example.com
   ```
3. Open the repo in VS Code → **Reopen in Container**. First build
   takes ~3-5 minutes — pulls the Python 3.11 base, runs `uv sync
   --extra dev` + `pnpm install`, and starts Postgres next to the
   dev container.
4. After the build:
   ```bash
   make doctor && make migrate && make login
   ```
5. Open [http://localhost:3000](http://localhost:3000) in the
   browser. Magic-link flow → paste-back code → in.

`DATABASE_URL` is baked into the container env
(`postgresql+asyncpg://eidan:eidan@db:5432/eidan`); the named volume
`eidan-db-data` persists data across container rebuilds. Wipe with
`docker volume rm <project>_eidan-db-data` to force a fresh DB.

`EIDAN_AUTH_MASTER_KEY` in the compose file defaults to a sentinel
dev value (`dev-only-replace-me-via-dot-env`) so a no-config boot
won't crash. Replace it via `.env` before you store anything you
care about — rotating later costs the contents of
`eidan.secrets_vault` and `eidan.auth_keypair`
([SECRETS §10](./012_SECRETS.md#10-master-key-rotation)).

The remaining sections of this doc cover **the bare-metal path** —
useful if you don't want Docker, are deploying to a Pi, or want to
understand what the container is doing.

## 0. Prerequisites

| Tool          | Why                             | Install                                                                |
|---------------|---------------------------------|------------------------------------------------------------------------|
| Python 3.11+  | Backend runtime                 | macOS: `brew install python@3.11` / Linux: `apt install python3.11`    |
| Node 20+      | Web UI                          | macOS: `brew install node` / Linux: `apt install nodejs`               |
| `uv`          | Workspace + venv manager        | `curl -LsSf https://astral.sh/uv/install.sh \| sh`                     |
| `pnpm`        | JS workspace                    | `npm i -g pnpm`                                                        |
| `git`         | Cloning                         | macOS: included / Linux: `apt install git`                             |
| `psql` (CLI)  | DB sanity-checking              | macOS: `brew install postgresql@16` / Linux: `apt install postgresql-client` |
| `docker`      | Optional — only for §1d         | [docker.com/get-started](https://www.docker.com/get-started/)          |

You'll also need:

- **Anthropic** ([console.anthropic.com](https://console.anthropic.com)) — for the API key the agent loop uses.
- **An email you'll log in with** — any address works; Eidan refuses
  every other email by default.

## 1. Database

Eidan needs Postgres ≥ 13 with `gen_random_uuid()`. Pick the option
that fits your box.

### 1a. macOS (homebrew)

```bash
brew install postgresql@16
brew services start postgresql@16
createuser -s eidan
createdb -O eidan eidan
psql -d eidan -c "ALTER USER eidan WITH PASSWORD 'eidan';"
```

`DATABASE_URL` becomes
`postgresql+asyncpg://eidan:eidan@localhost:5432/eidan`.

### 1b. Linux (apt)

```bash
sudo apt update && sudo apt install -y postgresql
sudo -u postgres createuser -s eidan
sudo -u postgres createdb -O eidan eidan
sudo -u postgres psql -c "ALTER USER eidan WITH PASSWORD 'eidan';"
```

Same `DATABASE_URL` as §1a.

### 1c. Docker (no install)

```bash
docker run -d --name eidan-pg \
  -e POSTGRES_USER=eidan \
  -e POSTGRES_PASSWORD=eidan \
  -e POSTGRES_DB=eidan \
  -p 5432:5432 \
  postgres:16
```

Same `DATABASE_URL`. Stop with `docker stop eidan-pg`; data persists
until you `docker rm eidan-pg`.

### Verify

```bash
psql "postgresql://eidan:eidan@localhost:5432/eidan" -c "SELECT 1"
```

Should print `1`. If not, fix the connection before moving on —
nothing else works without a reachable Postgres.

## 2. Auth: master key + allow-list

Eidan ships its own auth. No Supabase project, no JWKS round-trip.
Two env vars are load-bearing.

### 2a. Master key

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Paste the output into `.env` as `EIDAN_AUTH_MASTER_KEY`. This value
HKDF-derives the Fernet key that seals:

- the RS256 signing keypair (`eidan.auth_keypair`),
- TOTP secrets (`eidan.auth_mfa_totp`),
- every entry in `eidan.secrets_vault`.

Rotating it means losing the contents of all three tables — see
[SECRETS §10](./012_SECRETS.md#10-master-key-rotation). Pick the
value once and back it up.

### 2b. Allow-list

```bash
EIDAN_AUTH_ALLOWED_EMAIL=you@example.com
```

This is the **only** email the magic-link endpoint will mint a link
for. Unset means "refuse everyone". The CLI's `make login` prompts
for your email; type the same one. The match is case-insensitive.

### 2c. SMTP (optional)

For real magic-link delivery, set the `EIDAN_SMTP_*` block in
`.env`. In dev (`EIDAN_DEPLOYMENT_MODE != production`) the backend:

- always logs the link to `logs/backend.log`,
- echoes it back on the `POST /api/auth/magic-link` response body so
  the web UI can render it inline.

You can leave SMTP unset locally and still log in.

## 3. Anthropic API key

1. [console.anthropic.com](https://console.anthropic.com) → **API Keys**
   → **Create Key**.
2. Copy it (starts with `sk-ant-`).
3. Add billing if you haven't (the API requires a paid account; you
   can deposit as little as $5).

Becomes `ANTHROPIC_API_KEY` in `.env`.

## 4. Clone + install

```bash
git clone https://github.com/sielay/eidan.git
cd eidan
make install
```

`make install` runs `uv sync --extra dev`. First run downloads ~50
Python packages including `anthropic`, `asyncpg`, `fastapi`,
`pydantic`, `python-jose[cryptography]`. The cryptography wheel can
take a minute on first install.

## 5. Configure `.env`

```bash
cp .env.example .env
$EDITOR .env
```

What you actually have to fill (everything else has dev defaults):

```bash
DATABASE_URL=postgresql+asyncpg://eidan:eidan@localhost:5432/eidan    # bare-metal
ANTHROPIC_API_KEY=sk-ant-...
EIDAN_AUTH_MASTER_KEY=<from §2a>
EIDAN_AUTH_ALLOWED_EMAIL=you@example.com
```

`.env` is auto-loaded by `eidan`'s CLI on every command — you don't
need to `source` it.

## 6. Sanity check

```bash
make doctor
```

Expected output on a clean working setup:

```
  Check                       Detail
  ✓  Postgres URL
  ✓  Anthropic API key
  ✓  EIDAN_AUTH_MASTER_KEY    set (48 bytes)
  ✓  EIDAN_AUTH_ALLOWED_EMAIL you@example.com
  ✓  Postgres reachable       server_version = 16.x
  ✗  Migrations applied       eidan schema does not exist. Run `make migrate`.
  ✓  Plugins discoverable     3 plugin(s): capture, example-core, learn
  ✗  Stored auth token        No stored token. Run `make login`.
```

The two ✗'s (migrations + stored token) are expected on first run;
they clear after §7 and §8.

## 7. Migrate

```bash
make migrate
```

Creates the `eidan` schema, the eight core tables, the five auth
tables (`auth_sessions`, `auth_magic_links`, `auth_mfa_totp`,
`auth_keypair`, `secrets_vault`), and the `plugin_state` table,
plus any plugin schemas. Idempotent — re-running is a no-op once
you're at head.

## 8. Sign in

```bash
make login
# prompts for email
# the CLI sends POST /api/auth/magic-link to the backend
# the backend mails the link via SMTP (if configured) and prints
# it to logs/backend.log either way
# in dev the response body echoes the link + 6-digit code too
```

Paste the 6-digit code back into the prompt. The CLI exchanges it
for the access token + refresh cookie via `POST /api/auth/verify`,
and persists them under your OS keyring (macOS Keychain / GNOME
Keyring / KWallet) or in `~/.eidan/auth.json` (mode 0600) if no
keyring backend is available.

The web UI's login page does the same flow in the browser — paste
the link or type the code, no CLI required.

## 9. Talk to your agent

```bash
make repl
```

```
signed in as you@example.com. Conversation 39f1….
loaded 3 plugin(s); 4 tool(s) registered
Type your message; Ctrl+D or /exit to leave.
you ▸ remember that rust uses tokio for async runtime
eidan ▸ Got it — saved as rust / async runtime. You can ask me what
        you know about rust anytime.
        (in 412t / out 87t / $0.00041 / 1820ms)
you ▸ what do I know about rust?
eidan ▸ You captured earlier: rust uses tokio for async runtime.
        (in 489t / out 64t / $0.00038 / 1340ms)
you ▸ /exit
```

Every turn writes rows to `eidan.messages` + `eidan.llm_calls`.
Inspect them with `psql`:

```bash
psql "$DATABASE_URL" -c "SELECT role, substring(content, 1, 60) FROM eidan.messages ORDER BY created_at DESC LIMIT 10"
```

For the browser experience, run `make dev` and open
[http://localhost:3000](http://localhost:3000).

## Troubleshooting

### `make doctor` says "Postgres reachable: Connection failed"

Is Postgres running?

```bash
pg_isready -h localhost          # bare-metal
docker ps | grep postgres        # §1c
```

Did you create the `eidan` user / DB?  `psql -l | grep eidan`.

### `make migrate` fails with "permission denied for schema public"

The user you connect as needs `CREATE` on the database. Re-run with
the superuser flag:

```bash
sudo -u postgres psql -c "ALTER USER eidan SUPERUSER"
```

(Strictly only needed on first migrate to provision the `eidan`
schema; you can revoke SUPERUSER afterward.)

### `make login` errors with "magic-link refused"

Two reasons:

1. `EIDAN_AUTH_ALLOWED_EMAIL` is unset. The host's safer default is
   to refuse every login when no allow-list is configured.
2. The email you typed doesn't match `EIDAN_AUTH_ALLOWED_EMAIL`.
   The comparison is case-insensitive but otherwise exact.

The endpoint always returns the same `{"status": "sent"}` envelope
regardless — check `logs/backend.log` for the WARN line if you're
unsure.

### Backend refuses to start: "EIDAN_AUTH_MASTER_KEY is not set"

The lifespan refuses to boot without a master key — see §2a.
Generate one and add it to `.env`.

### `auth.invalid_signature` mid-session

Either the access token expired (default 24 h) or the keypair was
rotated. The browser refreshes automatically via the refresh
cookie; the CLI does too as long as the stored refresh token is
still valid. If neither helps, run `make logout` then `make login`.

### `asyncpg` build errors on Linux

`asyncpg` builds against the system's libpq. If install errored,
`sudo apt install libpq-dev` then retry `make install`.

### Container can't reach Postgres

In the dev container, the database service is reachable at
`db:5432`, **not** `localhost`. The compose file already exports
the right `DATABASE_URL`; if you overrode it in `.env`, drop the
override or set it to
`postgresql+asyncpg://eidan:eidan@db:5432/eidan`.

## What you can do next

- **Conversational memory.** `remember X` / `note X` / `event X` all
  flow through the agent's tool calls when relevant. Try
  `remember that the kitchen tap drips when the boiler is on` then
  later ask `what do I know about the kitchen?`.
- **Cost watching.** Every turn prints `(in <toks> / out <toks> /
  $<cost> / <latency>ms)`. Tune `EIDAN_DEFAULT_MODEL` in `.env` to
  `claude-sonnet-4-6` or `claude-haiku-4-5-20251001` for cheaper
  turns.
- **Try the HTTP surface.** `make server` runs the FastAPI app on
  `:8000`; `EIDAN_BACKEND_URL=http://localhost:8000 make repl` then
  uses the HTTP path instead of in-process.
- **Plug in.** `plugins/learn/` and `plugins/capture/` are the
  reference shape. [PLUGINS](./001_PLUGINS.md) is the contract.
