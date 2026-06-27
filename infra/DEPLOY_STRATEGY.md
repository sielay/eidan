<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Deployment Strategy: Auto-Deploy Without Laptop Dependency

## Current State

**Topology:**
- **Fly** (eidan-core): main production API endpoint, runs full plugin set
- **Kesha** (192.168.1.100): local Raspberry Pi, runs docker compose stack (engine + postgres)
- **Local**: development (laptop) — currently a deploy bottleneck

**Flow (manual, requires laptop):**
1. Code → push to GitHub
2. Merge to `main` (via PR)
3. Operator runs `eidan-deploy.mjs` from laptop with env loaded
4. Deploy CLI: ssh/rsync to target, build/pull images, restart services
5. Fly: manual `flyctl` deploy or via release-images.yml (tags only)
6. Kesha: compose-ssh target pulls from GHCR, restarts

**Gaps:**
- No auto-detect of merged code
- Laptop is a blocker (away → no deploys)
- Kesha cannot test a new version in parallel with production
- No self-healing or retry on failed updates
- Fly box cannot auto-redeploy after merge (manual or tag-based only)
- No headless mechanism for CI/CD → deploy orchestration

---

## Proposed Strategy

### 1. Image Release Pipeline (CI/CD to GHCR)

**Goal:** Produce immutable, versioned images from every merge without laptop involvement.

**Mechanism: GitHub Actions (`on: push to main`)**
- Trigger: any merge to `main` (not just tags)
- Build: multi-arch (amd64 + arm64) engine + web images
- Tag: `ghcr.io/sielay/eidan-engine:main-latest` (live ref) + commit-sha tag (immutable)
- Push: to GHCR (no signing — defer to operator's registry policy)
- Artifacts: store image SHAs in GH Actions artifacts for audit trail

**New workflow:** `.github/workflows/deploy-on-merge.yml`
- Reuse current `release-images.yml` logic (buildx multi-arch)
- Tags: `:main-latest`, `:main-<short-sha>`, keep `:latest` for releases only
- No manual `flyctl` deploy here — just image push
- Failure blocks the merge? *No* (allow merges even if images fail; retryable)

**Why:** Images are the contract. Once in GHCR, any node can pull and run. Immutable SHA tags let us trace what version is running.

---

### 2. Fly Auto-Deploy (Detect Merge, Trigger Redeploy)

**Goal:** Fly box auto-detects merged code and redeployes without laptop.

**Option A: Fly's Native Deploy Hooks (Recommended, Zero Infrastructure)**
- Fly supports HTTP webhooks: when `fly deploy` runs, Fly can POST to a GitHub hook URL
- **Inversion:** GitHub push → Fly webhook → `flyctl deploy --image ghcr.io/sielay/eidan-engine:main-latest`
- **Trigger:** GitHub Actions in `.github/workflows/deploy-to-fly.yml`
  - After image lands in GHCR, call `flyctl deploy --image <digest>`
  - Uses Fly's `FLY_API_TOKEN` (secret in GH Actions)
  - Idempotent: re-running the workflow re-runs the deploy
- **State:** Fly tracks deployed commit in its `fly.toml` or via `flyctl apps show`; no db needed
- **Rollback:** `flyctl rollback --app <app>` reverts to previous release

**Option B: Kesha-Based Webhook (More Complex, Deferred)**
- Deploy an eidan agent on Kesha that listens for GitHub webhooks
- Triggered by GitHub → eidan agent → `flyctl deploy` from Kesha
- Requires: Kesha has `flyctl` + `FLY_API_TOKEN` in vault
- Benefit: all deploys orchestrated from eidan; headless ✓

**Adopt Option A first** (simpler, leverage Fly's native tools). Option B is future if eidan agents need to coordinate multi-target deploys.

**Sequence:**
```
1. dev commits code → PR
2. PR merged to main → GitHub push event
3. GitHub Actions: build + push image to GHCR
4. GitHub Actions: call `flyctl deploy --image ghcr.io/.../eidan-engine:main-latest`
   - Uses FLY_API_TOKEN secret
   - Deploys new image to Fly
5. Fly runs migrations + restarts app
6. Fly health checks confirm ready
```

**Blockers to handle:**
- `FLY_API_TOKEN` must be in GH Actions secrets (operator responsibility, gitignored)
- Migrations: Fly's `release_command` runs idempotent `pnpm --filter @eidandev/migrate migrate` within the build environment; ensure `DATABASE_URL` and `pnpm` are available in the deploy image
- Secrets: Fly secrets (EIDAN_DATABASE_URL, keys) are pre-set; workflow does NOT edit them; `FLY_API_TOKEN` is only used in GH Actions runner, not exposed on the deployed machine

---

### 3. Kesha Parallel Staging + Production Slots

**Goal:** Test new code on Kesha in parallel; swap to production only when ready.

**Architecture: Docker Compose Profiles + Shared Postgres**
```
docker-compose.yml
├── services:
│   ├── postgres: shared across all slots
│   ├── engine-prod: profile: prod (current live)
│   ├── engine-staging: profile: staging (new code, parallel)
│   ├── web-prod: profile: prod
│   └── web-staging: profile: staging
│
├── volumes: kesha-pgdata (shared by both slots)
```

**Flow:**
- **Production slot** runs `main-current` image (last known-good)
- **Staging slot** pulls `main-latest` from GHCR (live build from latest merge)
- Both connect to *same* Postgres DB (kesha-pgdata)
- Both run on separate internal IPs (localhost:8090-prod, localhost:8091-staging)

**Promotion: Staging → Production**
- Operator tests staging (manual curl, browser, etc.)
- If ready: update `.env` with `EIDAN_ENGINE_IMAGE_TAG=main-latest`, then `docker compose -p kesha up -d --profile prod`
  - Redeploy prod to latest image
  - Old prod still running until new one's health check passes
- If not: downtime is minimal (only if explicit promotion ordered)

**Implementation:**
- New `infra/fly-mb/docker-compose.staging.yml` (profiles: prod, staging)
- Kesha deploy target adds `.env` var: `KESHA_STAGING=1` (enables staging profile pull)
- Kesha startup script (systemd or cron): `docker compose -p kesha pull --quiet; docker compose -p kesha up -d --profile prod --profile staging`
- Optional: health-check endpoint (`/health`) returns git SHA + uptime; staging dashboard pings both slots

**Self-healing:**
- Kesha's systemd timer: every 10m, pull latest images and restart exited containers
  ```ini
  [Unit]
  Description=Kesha auto-update + self-heal
  OnBootSec=5min
  OnUnitActiveSec=10min

  [Install]
  WantedBy=timers.target
  ```
- Script: `docker compose -p kesha pull --quiet; docker compose -p kesha up -d --no-deps` (restart if changed)
- **Interaction:** Timer runs independently from `kesha-eidan.service`; both pull + restart, but the service ExecStart is already detached (`-d`), so no race conditions with blocking startup

---

### 4. Self-Healing: Boxes Pull Latest on Startup

**Goal:** New container / box reboot = auto-pull latest code (no manual intervention).

**Fly:**
- Fly's `fly.toml` already supports automated deployments
- Add section: `[deploy] strategy = "rolling"`  (zero-downtime rolling updates)
- Use `fly scale vm shared-cpu-1x` (cost-efficient)
- Fly PostgreSQL managed: backups automated, failover managed

**Kesha (systemd service with health-check fallback):**
```ini
# /etc/systemd/system/kesha-eidan.service
[Unit]
Description=Kesha eidan stack (engine + postgres)
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/eidan
# On startup: pull latest images (fail gracefully if offline)
ExecStartPre=/usr/bin/sh -c 'docker compose -p kesha pull --quiet 2>/dev/null || true'
# Run the stack with prod profile (and staging if enabled)
ExecStart=/usr/bin/docker compose -p kesha up -d --remove-orphans
# On stop: graceful shutdown
ExecStop=/usr/bin/docker compose -p kesha down
# Health check: query /health endpoint, auto-rollback if fails
ExecStartPost=/usr/bin/sh -c '/opt/kesha-health-check.sh'

Restart=on-failure
RestartSec=30s

[Install]
WantedBy=multi-user.target
```

**Health check script** (`/opt/kesha-health-check.sh`):
```bash
#!/bin/bash
# Polls /health endpoint; if all retries fail, rollback to KESHA_PREVIOUS_SHA
source /home/pi/eidan/.env

MAX_RETRIES=3
RETRY_DELAY=5
HEALTH_URL="http://localhost:8090/health"

for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    echo "Health check passed (attempt $i)"
    exit 0
  fi
  echo "Health check failed (attempt $i/$MAX_RETRIES)"
  sleep $RETRY_DELAY
done

# All retries failed → rollback
echo "Health check failed after $MAX_RETRIES attempts. Rolling back to previous SHA: $KESHA_PREVIOUS_SHA"
export EIDAN_ENGINE_IMAGE_TAG="$KESHA_PREVIOUS_SHA"
docker compose -p kesha down
docker compose -p kesha up -d --profile prod
sleep 5
# Verify rollback
if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  echo "Rollback successful"
  exit 0
else
  echo "Rollback failed. Manual intervention required."
  exit 1
fi
```

**Note on ExecStartPost timing:** Since `ExecStart` runs in detached mode (`-d`), `ExecStartPost` fires immediately after containers are launched (not after they're healthy). The health check script itself handles retries and waits for services to be ready; the systemd unit does not block on service health.

**Startup sequence:**
1. Systemd starts: `docker compose pull` (non-blocking if offline)
2. `docker compose up` starts all services (prod + staging profiles)
3. `ExecStartPost` runs health check script
4. If health check passes: all good, deployment is live
5. If health check fails 3x: auto-rollback to `KESHA_PREVIOUS_SHA`

- **Reboot** → systemd → `docker compose pull` + `up` + health check → rollback if needed
- **Crash** → systemd restarts service (retry backoff)
- **Manual restart**: `sudo systemctl restart kesha-eidan`

**Health check endpoint** (`/health` on eidan host):
- Returns `{ "version": "<git-sha>", "uptime": <ms>, "role": "prod|staging", "status": "ok" }`
- Live, queryable even during migrations (critical for health checks)
- Added in Phase 3 implementation

---

### 5. Headless Deploy Triggers (Agent-Initiated)

**Goal:** Eidan agents can trigger deploys without operator interaction.

**Not immediately required**, but design space:

**Option A: Deploy Agent (Future)**
- Eidan plugin: `@eidandev/deploy-agent`
- Exposes tool: `deploy_staging_to_prod(environment, image_sha)`
- Operator adds to `EIDAN_JOB_KINDS` on a control node
- Accessible via MCP/A2A: other agents → eidan → `flyctl` / `docker compose` commands
- Requires: SSH keys + `flyctl`/`docker` in eidan container (or delegate via SSH)

**Option B: Webhook Agent (Cheaper)**
- Eidan listens on `/deploy-webhook` (authenticated with HMAC)
- GitHub Actions POST after image build: `POST /api/webhook/deploy` + signature
- Eidan logs the event, makes it queryable, fires a `deploy_requested` event
- Future: agents can subscribe and decide (e.g., "auto-promote staging if tests pass")

**Defer to Phase 2** — get image pipeline + Fly auto-deploy working first. Then add agent orchestration.

---

## Blockers & Mitigations

| Blocker | Impact | Mitigation |
|---------|--------|-----------|
| **Secrets in GH Actions** | `FLY_API_TOKEN`, GHCR credentials must be in GH secrets | Operator responsibility. Store in GH Settings → Secrets. Never commit. Document setup in external docs (wiki, notion, etc.) — do not track even a template in the repo. |
| **Postgres migrations fail** | Deploy succeeds, but app can't start if schema is old | Migrations are idempotent. Post-deploy: `flyctl ssh -c 'pnpm --filter @eidandev/migrate migrate'`. Add to Fly's `release_command` in `fly.toml`. |
| **Image pull rate limits** | GHCR pulls from CI + Kesha exhaust quota | Use GitHub Container Registry token (authed, higher limits). Store in Kesha `.env` as `DOCKER_AUTH_CONFIG`. |
| **Database downtime during Kesha redeploy** | Staging + prod share same DB; schema changes block both | Use Postgres columns-are-additive strategy. Old code still sees new columns (just ignores them). Never drop/rename columns without coordination. |
| **Fly secrets out of sync** | New env var added, but Fly not updated | All secrets pre-set via `fly secrets import` in initial deploy. Update via `flyctl secrets import <(cat gitignored-secrets.txt)` for batch sync, or `flyctl secrets set KEY=VALUE` individually. |
| **Kesha can't reach GHCR** | Offline or rate-limited → staging can't pull | Kesha docker login via vault secret. If offline: `ExecStartPre` fails gracefully (pull is non-blocking); health check detects failure and auto-rolls back to `KESHA_PREVIOUS_SHA`. For staging: manual pull via `docker compose -p kesha pull` can be retried when network is restored. |
| **Concurrent deploys race** | Two `flyctl deploy` calls at same time | GitHub Actions workflow queue ensures sequential (default). Fly does not allow parallel deploys of same app. |
| **Rollback without web UI access** | Web interface down → can't access dashboard to revert | MCP/A2A/SSH/Postgres remain available. Fly rollback via `flyctl` CLI. Kesha rollback via SSH. CI/CD rollback job available as safety net. |
| **Kesha image pull fails mid-deploy** | Staging pulls `:main-latest`, but pull fails → staging stuck on old image | Health check detects failure, auto-rolls back to `KESHA_PREVIOUS_SHA`. Manual SSH recovery available. |

---

## Implementation Roadmap

### Phase 1: Image Pipeline + Fly Auto-Deploy (Week 1)
- [ ] Create `.github/workflows/deploy-on-merge.yml` (build + push on `main` merge)
- [ ] Add `flyctl deploy` step using `FLY_API_TOKEN` secret
- [ ] Test: merge dummy PR → GHCR image + Fly deploy
- [ ] Add post-deploy migration hook in `fly.toml` (`release_command`)
- [ ] Document: operator setup (FLY_API_TOKEN in GH secrets)
- [ ] Create `.github/workflows/rollback-to-fly.yml` (manual rollback trigger via CI/CD)
- [ ] Test rollback: merge a change, deploy, then rollback via `gh workflow run`

### Phase 2: Kesha Staging Slots (Week 2)
- [ ] Create `infra/fly-mb/docker-compose.staging.yml` (prod + staging profiles, use `EIDAN_ENGINE_IMAGE_TAG` env var)
- [ ] Kesha initial setup: create `.env` template with `KESHA_STAGING=1`, `EIDAN_ENGINE_IMAGE_TAG=main-latest`, `KESHA_PREVIOUS_SHA=<stable-sha>` (gitignored)
- [ ] Test: `docker compose -p kesha up -d --profile staging` pulls image from `EIDAN_ENGINE_IMAGE_TAG`
- [ ] Add health check endpoint to matbot host (git SHA + uptime + role)
- [ ] Document: testing workflow for staging; manual promotion step
- [ ] Implement health-check polling in Kesha systemd service (3 retries, auto-rollback on failure)

### Phase 3: Self-Healing & Emergency Recovery (Week 3)
- [ ] Create systemd service + timer for Kesha auto-pull (per section 4 above)
- [ ] Test: reboot Kesha → auto-pulls latest images, runs health check, auto-rollbacks if needed
- [ ] Fly `fly.toml`: enable `strategy = "rolling"` (zero-downtime rolling updates) + configure `auto_stop_machines = true` for zero-cost idle
- [ ] Track `/opt/kesha-health-check.sh` in `infra/scripts/kesha-health-check.sh`; deploy during Kesha setup
- [ ] Document SSH recovery procedures for Kesha (manual rollback: update `.env EIDAN_ENGINE_IMAGE_TAG=<sha>`, restart service)
- [ ] Document MCP/A2A/Postgres access paths for when web UI is down
- [ ] Verify emergency access paths work: test each (MCP curl, Postgres SSH, A2A port)

### Phase 4: Deploy Agent (Future)
- [ ] Design `@eidandev/deploy-agent` plugin (MCP-exposed tool)
- [ ] Implement: `trigger_staging_to_prod`, `check_deploy_status`
- [ ] Kesha Postgres: add `deployment_events` audit log
- [ ] Document: agent-driven deploy orchestration

---

## Commit → Deploy Sequence (End-to-End)

```
T+0:00  Developer commits code → PR → merge to main
T+0:05  GitHub webhook → Actions: build multi-arch image
T+0:15  Image pushed to ghcr.io/sielay/eidan-engine:main-latest + SHA tag
T+0:16  Actions: call `flyctl deploy --image ghcr.io/sielay/eidan-engine:main-<sha>`
T+0:25  Fly: rolling update (new app instance, health checks, old termination)
T+0:30  Fly: post-deploy runs `pnpm migrate` (idempotent, quick if schema unchanged)
T+0:35  Fly: live, health checks passing
        [End: Fly is on new code]

        [Meanwhile, background tasks on Kesha:]
T+0:15  Kesha's docker daemon pulls new image (if `pull --quiet` is running)
T+1:00  Kesha systemd timer fires: `docker compose -p kesha pull; docker compose -p kesha up -d --profile staging`
        Staging slot now runs new code (prod unchanged)
T+1:05  Operator tests staging via browser / curl
T+1:10  [Manual] Operator promotes: update `.env EIDAN_ENGINE_IMAGE_TAG=main-latest`, then `docker compose -p kesha up -d --profile prod`
        Prod slot redeploys to new image (mirrors Fly)
```

**Result:** Fly is auto-live in ~35m. Kesha staging tests in parallel. Operator can promote on demand or auto-promote on tests passing (future).

---

## Gitignored Config & Secrets

**Tracked:**
- `.github/workflows/deploy-on-merge.yml` (image build)
- `.github/workflows/deploy-to-fly.yml` (Fly redeploy)
- `infra/fly-mb/docker-compose.staging.yml` (staging topology; uses `EIDAN_ENGINE_IMAGE_TAG` env var)
- `infra/fly-mb/kesha.service` (systemd service template; deployed to `/etc/systemd/system/kesha-eidan.service` on Kesha)
- `infra/scripts/kesha-health-check.sh` (health check script template; deployed to `/opt/kesha-health-check.sh` on Kesha at setup)
- `DEPLOY_STRATEGY.md` (this doc)

**Gitignored (operator-private):**
- `FLY_API_TOKEN` (GitHub Actions secret setting, not in repo)
- `.env` (Kesha config: `KESHA_STAGING=1`, `EIDAN_ENGINE_IMAGE_TAG=<main-latest>`, `KESHA_PREVIOUS_SHA=<fallback>`, `DOCKER_AUTH_CONFIG`, etc.)
  - `EIDAN_ENGINE_IMAGE_TAG` is updated by health check rollback script on emergency recovery
  - `KESHA_PREVIOUS_SHA` is set manually or by automation before deploy
- `eidan.deploy.json` (already gitignored)
- `/etc/eidan/eidan.env` (Kesha system config)
- `/opt/kesha-health-check.sh` (Kesha health check script, tracked in `infra/scripts/` and deployed at setup time)

**No secrets ever committed.**

---

## Rollback & Failure Recovery

**Critical:** Both Fly and Kesha must be capable of rolling back independently, with manual recovery procedures that do NOT require the web interface or eidan agents.

### Fly Rollback

**Pre-Requisite:** Fly keeps a release history. Each deploy is immutable + tagged.

**Rollback Paths (in order of preference):**

1. **Via `flyctl` (laptop or CI/CD):**
   ```bash
   flyctl rollback --app <app>
   ```
   Reverts to the previous release. Fast, idempotent, zero dependencies.

2. **Via GitHub Actions (headless):**
   - Create `.github/workflows/rollback-to-fly.yml` (manual trigger)
   - User runs: `gh workflow run rollback-to-fly.yml --raw`
   - Workflow: `flyctl rollback --app <app>` using `FLY_API_TOKEN` secret
   - No web interface needed; only GitHub CLI.

3. **Via Fly Dashboard (web, if accessible):**
   - Go to Fly dashboard → app → "Releases" tab
   - Click "Revert" on the previous release
   - Works even if the app is down (Fly re-routes traffic immediately)

**Scenario: App is broken, web interface is down:**
- Fly health checks detect failure → auto-pauses bad release (configurable in `fly.toml`)
- Previous release automatically re-activates
- If auto-recovery doesn't trigger: use `flyctl rollback` from any machine with the token

**Recovery if Fly database is corrupt:**
- Fly Postgres managed service: automatic daily backups, point-in-time recovery available
- Operator action: `flyctl pg connect <db-app>` → check `eidan._migrations` table
- If schema is ahead of code: either redeploy a newer version or restore from backup
- Postgres is never part of the image — data is safe across app redeploys

### Kesha Rollback

**Pre-Requisite:** Kesha maintains two image references: `main-current` (production) and `main-latest` (staging). Git SHAs are immutable tags.

**Rollback Paths (in order of preference):**

1. **Via SSH (manual, always available):**
   ```bash
   ssh pi@192.168.1.100
   # Update .env to use previous SHA
   sed -i 's/EIDAN_ENGINE_IMAGE_TAG=.*/EIDAN_ENGINE_IMAGE_TAG=main-<previous-sha>/' /home/pi/eidan/.env
   # Restart service (triggers health check)
   sudo systemctl restart kesha-eidan
   ```
   Requires SSH key + `pi` sudo access (pre-configured at deploy time).

2. **Via Kesha's health-check fallback (automatic):**
   - On startup, health check queries `/health` endpoint
   - If health check fails for 3 retries: automatically revert to `.env` var `KESHA_PREVIOUS_SHA`
   - This is the primary "self-healing" rollback when a new image is broken

3. **Via Eidan agent (future, Phase 4):**
   - `@eidandev/deploy-agent` exposes: `rollback_kesha_to_sha(image_sha)`
   - Requires: Kesha can SSH to itself (or docker socket access to host)
   - Not recommended for emergency recovery (depends on the agent being alive)

4. **Via health check auto-rollback (automatic if health checks enabled):**
   - Startup health checks detect failure and automatically roll back to `.env KESHA_PREVIOUS_SHA`
   - No manual intervention needed if auto-rollback is configured

**Scenario: Kesha is running broken code, web interface is down:**
- SSH into Kesha (192.168.1.100)
- Check current state: `docker compose -p kesha ps`
- View logs: `docker compose -p kesha logs engine-prod`
- If broken: manually revert prod to previous SHA (see SSH path above)
- Postgres is local to Kesha; data persists across container restarts

**Scenario: Kesha Postgres is corrupt:**
- Kesha runs a local Postgres container with `kesha-pgdata` volume
- Backup strategy: daily snapshots via cron (separate concern, outside deploy)
- If corruption detected: restore from backup or rebuild from Fly's Postgres (operator's choice)

### Web Interface Broken — Emergency Access Paths

**When the web interface (Next.js app or AG-UI) is broken:**

The web interface is ONE application layer. Core eidan services can still be accessed via:

1. **Postgres directly** (schema is queryable):
   ```bash
   ssh pi@192.168.1.100
   # Connect to Kesha's local postgres
   psql -h localhost -U eidan eidan
   # Query current state
   SELECT * FROM eidan.llm_calls LIMIT 1;
   SELECT * FROM eidan.messages WHERE created_at > now() - interval '1 hour';
   ```
   Allows direct inspection of state, manual corrections, or audit.

2. **MCP server** (port 8091, JSON-RPC over HTTP):
   ```bash
   curl -X POST http://192.168.1.100:8091/rpc \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   ```
   Eidan's MCP server is independent of the web UI. Can call tools, introspect state, trigger procedures.
   *(Requires port 8091 mapped in `docker-compose.yml`: `ports: ["8091:8091"]` for the MCP service)*

3. **A2A interface** (port 8095, agent-to-agent, if available):
   ```bash
   curl -X POST http://192.168.1.100:8095/agent/message \
     -H "Content-Type: application/json" \
     -d '{"agent_id":"sage","message":"what is my current state?"}'
   ```
   Allows remote agents (e.g., sage running elsewhere) to query eidan even if web UI is down.
   *(Requires port 8095 mapped in `docker-compose.yml`: `ports: ["8095:8095"]` for the A2A service)*

4. **Direct systemd/docker commands** (if SSH is available):
   ```bash
   ssh pi@192.168.1.100
   sudo systemctl status kesha-eidan
   docker logs <container-id>
   docker inspect <container-id>
   ```
   Lowest-level access to app state, logs, environment.

**Design principle:** The web interface is stateless and ephemeral. Core services (Postgres, MCP, A2A, systemd) remain accessible for recovery even if the UI layer fails.

### Deployment Abort (Before Committing to New Code)

If a deploy is in progress and you detect a problem:

**Fly:** 
- `flyctl deployments list --app <app>` — show active release
- If deploying: `flyctl deployments cancel-v2 <deployment-id>` (stops the deploy mid-roll, reverts)

**Kesha:**
- If `docker compose pull` is hanging (systemd timer): kill the timer job (`sudo systemctl stop kesha-eidan-update.timer`) or let it timeout
- If `docker compose up` is running: `sudo systemctl stop kesha-eidan` (stops containers gracefully)
- Previous image stays running; no change is committed

---

## Emergency Quick Reference

**Everything is broken — what do I do?**

| Scenario | First Action | Backup Plan |
|----------|--------------|-------------|
| **Fly app is down** | `flyctl rollback --app <app>` | GitHub Actions: `gh workflow run rollback-to-fly.yml --raw` |
| **Kesha app is down** | SSH: `ssh pi@192.168.1.100` → check `docker compose ps` | If SSH fails: reboot Kesha (power cycle or remote reboot if available) |
| **Web UI is broken, everything else works** | Not an emergency; use MCP/A2A/Postgres directly (see "Web Interface Broken" above) | — |
| **Web UI is down, need to rollback Kesha** | SSH: update `.env EIDAN_ENGINE_IMAGE_TAG=<previous-sha>` → `sudo systemctl restart kesha-eidan` | Manual power cycle + health check auto-rollback |
| **Postgres data corruption** | Kesha: assess severity via `psql` | Restore from backup (operator's backup strategy) |
| **Image pull is hanging** | `docker kill <pull-process>` or force-restart Kesha | Roll back to previous stable image |
| **Deploy is in progress and failing** | For Fly: `flyctl deployments cancel-v2 <id>` | For Kesha: `systemctl stop kesha-eidan` |

**Key facts:**
- **Fly:** Releases are immutable. Rollback is atomic. Previous release auto-activates.
- **Kesha:** Prod/staging slots are independent. Rollback is manual via SSH or automatic via health check.
- **Web UI is optional:** Core services (Postgres, MCP, A2A) remain accessible even if the UI is completely broken.
- **SSH is always available:** Kesha admin access via SSH is the ultimate recovery path (pre-configured at deploy time).

---

## Open questions

- **Health check auto-rollback:** Should it roll back automatically on failed checks (default), or only log and alert, requiring manual promotion from staging?
- **Kesha staging promotion:** Should promotion from staging → production be manual (operator decision) or automatic (e.g., on successful health check + time gate)?
- **Kesha Postgres backups:** What backup strategy for the local Kesha Postgres? Daily snapshots, continuous WAL archiving, or restore-from-Fly-on-emergency?
- **Fly staging slot:** Is Fly-only staging (separate app instance) in scope, or is Kesha's parallel slot sufficient for testing before Fly deploy?
