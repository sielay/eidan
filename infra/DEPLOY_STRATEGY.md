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
- Migrations: post-deploy, `flyctl ssh` runs `pnpm --filter @eidandev/migrate migrate` idempotent
- Secrets: Fly secrets (EIDAN_DATABASE_URL, keys) are pre-set; workflow does NOT edit them

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
- If ready: `docker compose -p kesha up -d --profile prod engine-prod:main-latest`
  - Redeploy prod to latest image
  - Old prod still running until new one's health check passes
- If not: downtime is minimal (only if explicit promotion ordered)

**Implementation:**
- New `infra/fly-mb/docker-compose.staging.yml` (profiles: prod, staging)
- Kesha deploy target adds `.env` var: `KESHA_STAGING=1` (enables staging profile pull)
- Kesha startup script (systemd or cron): `docker compose pull --quiet; docker compose up -d --profile prod --profile staging`
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
- Script: `docker compose pull --quiet; docker compose up -d --no-deps` (restart if changed)

---

### 4. Self-Healing: Boxes Pull Latest on Startup

**Goal:** New container / box reboot = auto-pull latest code (no manual intervention).

**Fly:**
- Fly's `fly.toml` already supports automated deployments
- Add section: `[deploy] strategy = "rolling"`  (zero-downtime rolling updates)
- Use `fly scale vm shared-cpu-1x` (cost-efficient)
- Fly PostgreSQL managed: backups automated, failover managed

**Kesha (systemd service):**
```ini
# /etc/systemd/system/kesha-eidan.service
[Unit]
Description=Kesha eidan stack (engine + postgres)
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/eidan
# On startup: pull latest images
ExecStartPre=/usr/bin/docker compose pull --quiet
# Run the stack
ExecStart=/usr/bin/docker compose up
# On stop: graceful shutdown
ExecStop=/usr/bin/docker compose down

Restart=on-failure
RestartSec=30s

[Install]
WantedBy=multi-user.target
```

- **Reboot** → systemd → `docker compose pull` + `up` → latest code runs
- **Crash** → systemd restarts service (retry backoff)
- **Manual restart**: `sudo systemctl restart kesha-eidan`

**Health checks:**
- Add `/health` endpoint to eidan (matbot plugin):
  - Returns `{ "version": "<git-sha>", "uptime": <ms>, "role": "prod|staging" }`
  - Kesha startup script polls health before marking deployment good
  - On failure: rollback to previous image SHA (stored in `.env`)

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
| **Secrets in GH Actions** | `FLY_API_TOKEN`, GHCR credentials must be in GH secrets | Operator responsibility. Store in GH Settings → Secrets. Never commit. Document in `.github/DEPLOY_SECRETS.md` (gitignored template). |
| **Postgres migrations fail** | Deploy succeeds, but app can't start if schema is old | Migrations are idempotent. Post-deploy: `flyctl ssh -c 'pnpm --filter @eidandev/migrate migrate'`. Add to Fly's `release_command` in `fly.toml`. |
| **Image pull rate limits** | GHCR pulls from CI + Kesha exhaust quota | Use GitHub Container Registry token (authed, higher limits). Store in Kesha `.env` as `DOCKER_AUTH_CONFIG`. |
| **Database downtime during Kesha redeploy** | Staging + prod share same DB; schema changes block both | Use Postgres columns-are-additive strategy. Old code still sees new columns (just ignores them). Never drop/rename columns without coordination. |
| **Fly secrets out of sync** | New env var added, but Fly not updated | All secrets pre-set via `fly secrets import` in initial deploy. Adds via gitignored `eidan.deploy.json`. `env-push` command syncs them. |
| **Kesha can't reach GHCR** | Offline or rate-limited → staging can't pull | Kesha docker login via vault secret. If offline: keep `main-current` tag; fallback to previous working image. |
| **Concurrent deploys race** | Two `flyctl deploy` calls at same time | GitHub Actions workflow queue ensures sequential (default). Fly does not allow parallel deploys of same app. |

---

## Implementation Roadmap

### Phase 1: Image Pipeline + Fly Auto-Deploy (Week 1)
- [ ] Create `.github/workflows/deploy-on-merge.yml` (build + push on `main` merge)
- [ ] Add `flyctl deploy` step using `FLY_API_TOKEN` secret
- [ ] Test: merge dummy PR → GHCR image + Fly deploy
- [ ] Add post-deploy migration hook in `fly.toml` (`release_command`)
- [ ] Document: operator setup (FLY_API_TOKEN in GH secrets)

### Phase 2: Kesha Staging Slots (Week 2)
- [ ] Create `infra/fly-mb/docker-compose.staging.yml` (prod + staging profiles)
- [ ] Update `eidan-deploy.mjs` kesha target to pull staging profile
- [ ] Kesha `.env`: add `KESHA_STAGING=1` (gitignored)
- [ ] Test: `docker compose up -d --profile staging` pulls `main-latest`
- [ ] Add health check endpoint to matbot host (git SHA + uptime)
- [ ] Document: testing workflow for staging

### Phase 3: Self-Healing (Week 3)
- [ ] Create systemd service + timer for Kesha auto-pull
- [ ] Test: reboot Kesha → auto-pulls latest images
- [ ] Add health-check polling to startup (fail if not ready)
- [ ] Fly `fly.toml`: enable `strategy = "rolling"`

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
T+1:00  Kesha systemd timer fires: `docker compose pull; docker compose up -d --profile staging`
        Staging slot now runs new code (prod unchanged)
T+1:05  Operator tests staging via browser / curl
T+1:10  [Manual] Operator promotes: `docker compose up -d --profile prod engine-prod:main-latest`
        Prod slot redeploys to new image (mirrors Fly)
```

**Result:** Fly is auto-live in ~35m. Kesha staging tests in parallel. Operator can promote on demand or auto-promote on tests passing (future).

---

## Gitignored Config & Secrets

**Tracked:**
- `.github/workflows/deploy-on-merge.yml` (image build)
- `.github/workflows/deploy-to-fly.yml` (Fly redeploy)
- `infra/fly-mb/docker-compose.staging.yml` (staging topology)
- `infra/fly-mb/kesha.service` (systemd template)
- `DEPLOY_STRATEGY.md` (this doc)

**Gitignored (operator-private):**
- `FLY_API_TOKEN` (GitHub Actions secret setting, not in repo)
- `.env` (kesha `KESHA_STAGING=1`, `DOCKER_AUTH_CONFIG`, etc.)
- `eidan.deploy.json` (already gitignored)
- `/etc/eidan/eidan.env` (Kesha system config)

**No secrets ever committed.**

---

## Unknowns & Decisions Needed

See "Open questions" section at the end of the PR description.
