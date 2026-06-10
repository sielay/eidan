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
migrations/             # the eidan.* Postgres schema (DDL)
infra/fly-mb/           # the deployable host image (Fly / any container)
```

Memory lives in Postgres under the `eidan` schema (conversations, messages, events, knowledge,
notes, agent_context, user_context, llm_calls, artifacts, jobs). The runtime reads and writes it
through `@eidandev/storage-postgres` with **keen, append-only** persistence — you own the data.

**Interop on three open protocols:** MCP (tools — in *and* out), AG-UI (the chat wire to your UI),
and A2A (agent-to-agent). Eidan speaks all three.

**The UI is your own.** matbot is a headless engine. Build (or bring) a Next.js app that talks to
`frontend-agui` over AG-UI for chat and reads Postgres directly for dashboards.

## Quick start

```bash
git clone --recurse-submodules https://github.com/sielay/eidan.git && cd eidan
( cd external/matbot && pnpm install )   # the runtime
pnpm install                             # the eidan plugins
cp infra/fly-mb/matbot.yaml ./matbot.yaml   # host config (gitignored)
```

Run the host (Node 24+ runs the TypeScript directly — no build step):

```bash
EIDAN_DATABASE_URL=postgres://eidan_app:...@host/eidan \
ANTHROPIC_API_KEY=sk-ant-... \
node --import ./external/matbot/apps/cli/register.js external/matbot/apps/cli/src/index.ts start
```

`EIDAN_DATABASE_URL` points at a Postgres with the `eidan` schema applied (`migrations/`), via a
**non-superuser** role so RLS enforces. Reach it on the AG-UI surface (`:8090`), the MCP server
(`:8091`), or the A2A agent (`:8095`).

### Deploy (Fly / container)

`infra/fly-mb/Dockerfile` builds the host image; `infra/fly-mb/fly.toml.example` is the Fly config.
`fly secrets set EIDAN_DATABASE_URL=… ANTHROPIC_API_KEY=…`, then `fly deploy`.

## Plugins & paid bundles

A plugin is one TypeScript module exporting a `MatbotPlugin` (`export const plugin`). Core ships
the packages above (AGPL). Pre-packaged paid bundles (coding, business, lifestyle) live in
standalone private sibling repos and drop in as more plugins — see [eidan.dev](https://eidan.dev).

## Licensing

- **Core** (AGPL v3) — free, self-hosted, source open forever.
- **matbot runtime** — Apache-2.0 (vendored submodule; its `LICENSE` preserved in-tree).
- **Paid bundles / commercial / hosted** — contact [licence@eidan.dev](mailto:licence@eidan.dev).

## Status

Eidan's core has migrated onto the matbot runtime (from an earlier Python/FastAPI stack). Still in
active development — expect breaking changes. Contributions welcome.

---

SIELAY Ltd 2026 · Built by [@sielay](https://github.com/sielay) and contributors.
