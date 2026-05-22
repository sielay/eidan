#!/usr/bin/env bash
# Runs once after the dev container is first built.
# Idempotent — safe to re-run (e.g. via "Rebuild Container" without "no cache").
#
# Network-dependent steps (corepack pulling pnpm from npm's CDN, uv
# pulling Python wheels from PyPI, pnpm pulling JS deps) all retry
# with exponential backoff. Cloudflare / npm / PyPI mid-download
# resets are common enough that a single failure should not abort
# the entire post-create — that would leave the operator stuck
# manually re-running steps.
set -euo pipefail

cd /workspaces/eidan

# ---- retry helper ------------------------------------------------------
# Usage: retry <label> <max_attempts> <cmd...>
# Sleeps 2s, 5s, 10s between tries. Exit code matches the final
# attempt's exit code (so ``set -e`` still catches a real failure).
retry() {
  local label="$1"
  local max="$2"
  shift 2

  local attempt=1
  local rc=0
  local -a delays=(2 5 10 20)
  while [ "$attempt" -le "$max" ]; do
    if [ "$attempt" -gt 1 ]; then
      local delay="${delays[$((attempt - 2))]:-30}"
      echo "    retry $attempt/$max for '$label' in ${delay}s…"
      sleep "$delay"
    fi
    if "$@"; then
      return 0
    fi
    rc=$?
    attempt=$((attempt + 1))
  done
  echo "!!! '$label' failed after $max attempts (last exit=$rc)" >&2
  return "$rc"
}

# Named volumes are created root-owned by Docker. Every tool that
# writes into them (the CLI's storage.py for ~/.eidan, uv for .venv,
# pnpm for the node_modules tree) runs as vscode, so claim ownership
# of each mount point before anything tries to touch it. Idempotent —
# the chown is a no-op once vscode already owns the path.
echo "==> Claiming named-volume mount points for vscode"
sudo chown -R vscode:vscode \
  /home/vscode/.eidan \
  /workspaces/eidan/.venv \
  /workspaces/eidan/node_modules \
  /workspaces/eidan/apps/web/node_modules \
  /workspaces/eidan/apps/backend/node_modules \
  /workspaces/eidan/packages/schemas/node_modules \
  /workspaces/eidan/docs-site/node_modules

echo "==> Enabling corepack + pnpm"
# No sudo: the devcontainers Node feature installs Node under
# /usr/local/share/nvm/... and adds `vscode` to the `node` group with
# write access, so corepack can drop shims without root. sudo here
# would reset PATH and lose corepack entirely.
#
# corepack downloads pnpm from the npm registry on first activation;
# transient Cloudflare resets show up as ``UND_ERR_SOCKET other side
# closed`` mid-stream. Retry rather than fail the container build.
corepack enable
retry "corepack prepare pnpm" 4 corepack prepare pnpm@9.0.0 --activate

echo "==> uv sync --extra dev (Python workspace + dev deps)"
# .venv is a named volume (see docker-compose.yml) so the host's
# macOS-built copy never reaches here. uv populates the empty mount
# point with a container-native interpreter + site-packages.
retry "uv sync" 4 uv sync --extra dev

# code-review-graph MCP server — Claude Code spawns `code-review-graph
# serve` from .mcp.json, so it needs to be on PATH inside the container.
# Installed as a uv tool to keep it out of the project venv.
echo "==> uv tool install code-review-graph"
retry "uv tool install code-review-graph" 4 \
  uv tool install code-review-graph

echo "==> pnpm install (JS workspace)"
# Two-tier retry: try frozen-lockfile first (fast happy path),
# then fall back to a regular install. Either path retries against
# transient network errors.
if ! retry "pnpm install (frozen)" 3 pnpm install --frozen-lockfile; then
  echo "    frozen-lockfile failed; retrying without --frozen-lockfile"
  retry "pnpm install" 4 pnpm install
fi

# Seed .env from .env.example on first run. DATABASE_URL is already
# baked into the container env (see docker-compose.yml), so we only
# need the operator to fill ANTHROPIC_API_KEY + EIDAN_AUTH_MASTER_KEY.
if [ ! -f .env ]; then
  echo "==> Seeding .env from .env.example"
  cp .env.example .env
fi

# Seed apps/web/.env.local from its template too. Without this the
# Next.js dev server reads no env at all and NEXT_PUBLIC_EIDAN_BACKEND_URL
# falls back to "" — which happens to be the right value for the Caddy
# proxy, but only by accident. Copying the example makes the intent
# (and the comment that documents the three supported values) explicit.
if [ ! -f apps/web/.env.local ]; then
  echo "==> Seeding apps/web/.env.local from apps/web/.env.example"
  cp apps/web/.env.example apps/web/.env.local
fi

cat <<'EOF'

================================================================
  Dev container ready.

  This container is wired for the Supabase path: eidan.* lives in
  Supabase's Postgres on the host (single DB, visible in Studio).
  If you'd rather use a standalone Postgres sidecar, see
  docs/LOCALHOST.md §1 — swap in docker-compose.standalone.yml and
  rebuild.

  Still needed before you can talk to the agent:
    1. On your HOST shell (not in this container), start Supabase:
         make supabase-up
       Then `make supabase-status` to grab the anon key. The OTP
       email viewer (Inbucket) is at http://localhost:54324; Studio
       is at http://localhost:54323.

    2. Edit .env and fill in:
         ANTHROPIC_API_KEY=sk-ant-...
         EIDAN_SUPABASE_ANON_KEY=<paste from `make supabase-status`>
       The Supabase URL / issuer / JWKS values in .env.example
       already point at host.docker.internal:54321 — leave them.

    3. make doctor       # verifies env + DB + JWKS
    4. make migrate      # creates the eidan schema + core tables in
                         #   Supabase's Postgres (visible in Studio)
    5. make login        # email OTP via local Supabase + Inbucket
    6. Pick a surface:
         make repl        # CLI REPL — fastest dev iteration
         make dev         # backend + web together via Turborepo
                          #   FastAPI :8000 + Next.js :3000
                          #   → http://localhost:3000

  Both :8000 (backend) and :3000 (web) are auto-forwarded — check the
  VS Code PORTS panel once `make dev` is running.

  DATABASE_URL is preset to
    postgresql+asyncpg://postgres:postgres@host.docker.internal:54322/postgres
  (Supabase's Postgres on the host).
================================================================
EOF
