# 🧙🏾‍♂️ Eidan

**Self-hosted personal agent OS for builders. Own your cognitive infrastructure.**

> Think about your personal `Jarvis`&trade;. A bit wiser than `Dum-E`&trade;, but not yet `Vision`&trade; level.

<p align="center">
<img alt="Eidan.dev — Self-hosted personal agent OS for builders. Own your cognitive infrastructure" src="./images/eidan_400.png" />
</p>

You run Eidan on your own server, computer, Raspberry Pi, pod — whatever. It keeps the
long-running memory — your conversations, notes, knowledge, and whatever your tools feed in —
in a **Postgres database that's yours** to read, back up, and walk away with. New capabilities
arrive as **plugins**.

The Core is open source **forever** (AGPL).

Built for 🌻 neurodivergent builders, 🤖 indie hackers, and solo founders who want cognitive
continuity without SaaS lock-in.

## Architecture

Eidan is a set of **plugins on the [matbot](https://github.com/MatAtBread/matbot) runtime** — a
thin, isomorphic-TypeScript agent engine (LLM ↔ tools ↔ frontends). matbot is vendored as a git
submodule at `external/matbot` (Apache-2.0); Eidan adds the parts that make it a product:

```
external/matbot/        # the agent runtime (Apache-2.0 submodule)
packages/
  storage-postgres/     # relational memory: Store<Session> + FileStore over the eidan.* schema
  memory/               # knowledge + notes; remember/recall tools (EidanMemory service)
  jobs/                 # delegation work-queue (eidan.jobs); bundles register kind handlers
  frontend-agui/        # chat surface over AG-UI (POST /api/turn) for the web UI
  auth/                 # JWT WebPrincipalResolver — per-request identity
  mcp-server/           # inbound MCP server (expose eidan tools to external agents)
  a2a-server/           # inbound A2A agent (expose eidan as an agent to other agents)
  notify/               # topic-routed outbound notifications (slack / telegram)
  llm-calls/            # per-call cost/token ledger -> eidan.llm_calls
apps/web/               # reference Next.js UI: chat over AG-UI + dashboards over Postgres
migrations/             # the eidan.* Postgres schema (SQL baseline + a Node migrate runner)
infra/fly-mb/           # the deployable host image (Fly / Pi / any container)
```

Memory lives in Postgres under the `eidan` schema (conversations, messages, events, knowledge,
notes, agent_context, user_context, llm_calls, artifacts, jobs). The runtime reads and writes it
through `@eidandev/storage-postgres` with **keen, append-only** persistence — you own the data.

**Interop on three open protocols:** MCP (tools — in *and* out), AG-UI (the chat wire to your UI),
and A2A (agent-to-agent). Eidan speaks all three.

**The UI is your own.** matbot is a headless engine. This repo ships a reference Next.js app
(`apps/web`) as the single same-origin front door: it proxies chat + auth through to the engine
(AG-UI over `frontend-agui`) and reads Postgres directly for the dashboards (RLS-scoped). Swap it
for your own — the engine doesn't care.

## Self-host with Docker (recommended)

The whole thing — Postgres, the engine, and the UI — in one command. Works on a Raspberry Pi, a
server, or a NAS (multi-arch images):

```bash
git clone --recurse-submodules https://github.com/sielay/eidan.git && cd eidan
cp .env.compose.example .env      # set ANTHROPIC_API_KEY, EIDAN_AUTH_JWT_SECRET, EIDAN_AUTH_ALLOWED_EMAIL
docker compose up -d              # → http://localhost:3001  (sign in with the magic link)
```

Updates are `docker compose pull && docker compose up -d`; your data is the Postgres volume. To use
an external database (Supabase/Neon), set `EIDAN_DATABASE_URL` and drop the `postgres` service.

**Shipping to a server, a Raspberry Pi, or Vercel — or adding paid bundles?** The deploy CLI makes it
easy: run the interactive wizard and it walks you through everything — no YAML, no flags.

```bash
pnpm eidan        # interactive wizard
```

On a fresh checkout it detects there's no config yet and does first-run setup — scaffolds the config +
secrets, prompts the essentials (DB, login email, API key, public URL — masked), and offers to run
migrations — then drops you in a menu: add a target, add a bundle, configure, `doctor`, `migrate`,
`deploy`. Scripting it in CI? Every step also has a plain verb:

```bash
node deploy/eidan-deploy.mjs deploy fly      # one command to any target — also: local · a Pi over ssh · Vercel
```

`deploy` assembles your bundles into the build and pushes any missing env to the target first, so it
goes live fully configured. Full guide: [deploy/README.md](deploy/README.md).

## Develop (run from source)

For hacking on the code (Node 24+ runs the TypeScript directly — no build step):

```bash
git clone --recurse-submodules https://github.com/sielay/eidan.git && cd eidan
( cd external/matbot && pnpm install )   # the runtime
pnpm install                             # the eidan plugins
cp matbot.yaml.example ./matbot.yaml     # host config (the real matbot.yaml is gitignored)
EIDAN_DATABASE_URL=postgres://eidan_app:...@host/eidan pnpm --filter @eidandev/migrate migrate
```

Run the host:

```bash
EIDAN_DATABASE_URL=postgres://eidan_app:...@host/eidan \
ANTHROPIC_API_KEY=sk-ant-... EIDAN_AUTH_JWT_SECRET=... MATBOT_PRINCIPAL=<eidan.users-uuid> \
node --import ./external/matbot/apps/cli/register.js \
     external/matbot/apps/cli/src/index.ts start --config ./matbot.yaml
```

`EIDAN_DATABASE_URL` points at a Postgres with the `eidan` schema applied (`pnpm --filter
@eidandev/migrate migrate`), via a **non-superuser** role so RLS enforces. Reach it on the AG-UI
surface (`:8090`), the MCP server (`:8091`), or the A2A agent (`:8095`). The reference UI runs with
`cd apps/web && pnpm install && pnpm dev` (set `NEXT_PUBLIC_EIDAN_BACKEND_URL=` empty + `EIDAN_ENGINE_URL`
to the host so it's the same-origin front door).

### Deploy (Fly / container)

`infra/fly-mb/Dockerfile` builds the host image — see **[infra/fly-mb/README.md](infra/fly-mb/README.md)**
for the full guide (required env, ports, `migrate`/update flow, and how a deploy vendors a paid
bundle). In short: `fly secrets set EIDAN_DATABASE_URL=… ANTHROPIC_API_KEY=…`, then `fly deploy`.

## Plugins & paid bundles

A plugin is one TypeScript module exporting a `MatbotPlugin` (`export const plugin`). Core ships
the packages above (AGPL). Pre-packaged paid bundles (coding, business, lifestyle) live in
standalone private sibling repos and are **vendored into the host image at deploy time** as more
plugins — they plug into core purely through the string-keyed service registry (e.g. a coding
bundle registers a `'code'` job handler), never editing core. See [eidan.dev](https://eidan.dev).

## Licensing

- **Core** (AGPL v3) — free, self-hosted, source open forever.
- **matbot runtime** — Apache-2.0 (vendored submodule; its `LICENSE` preserved in-tree).
- **Paid bundles / commercial / hosted** — contact [licence@eidan.dev](mailto:licence@eidan.dev).

## Status

Eidan's core has migrated onto the matbot runtime (from an earlier Python/FastAPI stack). Still in
active development — expect breaking changes. Contributions welcome.

---

SIELAY Ltd 2026 · Built by [@sielay](https://github.com/sielay) and contributors.
