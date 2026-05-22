# Eidan Architecture

## What this document is

The authoritative shape of Eidan's core architecture. Intentionally short — roughly one screen per component, no SQL DDL beyond what shapes decisions. Per-area details (plugin contract, migration tiering, provider adapters, etc.) live in numbered sibling docs as they get written.

---

## Principles

**Keen saving.** Every user message and every LLM/tool response is persisted to the DB *before* being forwarded to the next step. Persistence happens at two layers — the entry point (UI, CLI, Telegram, ...) and the Python backend agentic loop. This is the single biggest fix relative to previous agents created by the author. Optimisation of what flows onward comes later; default behaviour is "save everything".

**Context discipline (not compression).** Lean base context. Knowledge and behaviours load just-in-time, decided by classifiers that themselves run with minimal context. See *Agentic loop*.

**Actionable prompts.** The repeating issue in previous agent
attempts was that LLM pretended to call tools or make actions,
and gave confirmations. Especially for plugins (but also via
prompt routing) we need to provide to LLM short, instructive
prompt and asking to provide input to the tools. We should try
to executre tools programatically, and direct LLM to plan their
usage in the following steps. Plugin commands and specific UI
inputs should simplify this targetting.

> Log coffee - should lead to agent actually logging the coffe

**Local-first.** Eidan must run on a Pi, a mini PC, or a cloud node. The same Python backend runs everywhere; only the configured providers and tools change.

**Multi-instance by default.** The Python backend is designed to run as more than one instance behind a load balancer (Fly.io regions, a Pi plus a cloud node, etc.). Postgres is the shared source of truth; work that needs a single owner (cron, scheduler, webhook router, in-conversation sequencing) elects a leader rather than assuming one process. Single-instance is a valid deployment, not a design assumption.

  - some nodes will run as runners only - e.g. when deployed to Pi rather than to Fly.io
  - some nodes won't run long jobs - e.g. on Fly.io due to their ephemeral nature.

**Single-user by default.** The schema permits many users; core ships without RLS so it is practically single-user. Some paid plugins add RLS for family-style, team or enterrprise sharing.

**Plugin-based growth.** Tools, integrations, and most user-visible features are plugins, not core. Core defines contracts and contains the agentic loop, memory, and provider abstraction.

**MCP-native.** Eidan exposes an MCP server (so other systems push data in) and acts as an MCP client (so it can consume MCP tools and other agent systems).

**Multi-provider.** No single LLM vendor lock-in. Core supports
Anthropic / OpenAI / Gemini / Mistral / local Llama-class. The user
configures which are available; the loop selects per turn. The
database is plain Postgres (any 13+ install works); auth is native
to Eidan — see [011](./011_AUTH_FLOW.md) for the RS256 magic-link
flow. MFA / OAuth providers extend the same provider interface.

**Telemetry by default.** Every LLM call is logged before its result is forwarded. Cost-budgeting and analytics read from this log — capture is core, dashboards ship in the universal paid baseline bundle.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js preferably on Vercel | Magic-link sign-in against the host's native auth surface. UI surface is intentionally minimal. |
| Backend | Python on Fly / Pi / Heroku / self-host | Single backend for all node types. Runs the agentic loop, plugins, MCP server and client. |
| Database | Plain Postgres, `eidan` schema | Direct asyncpg connection from backend. Postgres 13+ is the only requirement. |
| Auth | Native (RS256 JWT, magic-link) | Host mints + verifies its own tokens; keypair stored encrypted in `eidan.auth_keypair`. See [011](./011_AUTH_FLOW.md). |
| Schemas | JSON Schema canonical | Zod for frontend (validation + inferred TS types); Pydantic for backend (generated). Single source. |
| Secrets — static | env vars | App-level API keys, master keys, provider keys. Friendly to k8s / commercial later. |
| Secrets — dynamic | Native vault (`eidan.secrets_vault`) | Per-user OAuth tokens, refresh tokens, anything user-specific and rotatable. Fernet-sealed with `EIDAN_AUTH_MASTER_KEY`. |

---

## Memory model

All memory tables live in the `eidan` schema, are append-only where possible, and use soft-deletes elsewhere.

- **`messages`** — The keen-save target and the event log of the system. Every user input and every LLM/tool response writes here first. Self-FK `parent_message_id` so subagent turns (and classifier/critic subagent calls) form a subtree under the parent's tool-use entry.
- **`events`** — Calendar-like items: commitments, schedules, promises, observations. Designed to be fed from external calendars and queried cheaply for heads-up surfaces ("what's due today / overdue / next week"). Indexed on `due_at` / `occurred_at`.
- **`knowledge`** — Semantic memory; what the agent *knows*. Skill-tagged markdown blobs (travel, technical, financial, health, planning, research, etc.).
- **`notes`** — Working memory the agent writes for itself: long-job state, hand-off to subagents, context-reset survival, conversation-rescue when the context limit hits.
- **`agent_context`** — Per-agent identity and role. Ships in code as defaults; user customisations layer on top per user.
- **`user_context`** — Durable facts about the user (identity, goals, constraints, preferences, projects).
- **`llm_calls`** — One row per LLM invocation. Provider, model, role (classifier / primary / critic), input tokens, output tokens, cache-hit tokens, cost estimate, latency, conversation/message FKs, error. Written before the result is forwarded. Read by cost-budgeting (core) and analytics (paid baseline bundle).

---

## Agentic loop

The loop is the heart of the system. Every conversational turn potentially runs three call types — scheduled distinctly, each with its own prompt, model, and budget.

### Three call types

**1. Classifier calls (context-free).** Run on cheap, fast models (Haiku-class or equivalent on other providers). Receive only the text to evaluate plus a minimal trigger list. They never see the conversation history or the loaded system prompt — this isolation is what makes them immune to context dilution.

Two scopes:

- **User-scope (pre-response):** evaluates the user's incoming message. Fires on meta-conversational signals (scope corrections, domain shifts, repetition frustration, ambiguous intent). Selects behaviours to load for *this* turn.
- **Agent-scope (post-response):** evaluates the model's output. Fires on unverified claims, circular reasoning, structural problems. Selects behaviours for the *next* turn. Two modes — **AUTO** (silently load) and **OFFER** (surface as an inline accept/dismiss affordance in the conversation UI).

Classifier output is a **numeric index**, not a behaviour name. Triggers are versioned and indexed at registration time, so the same index always points at the same trigger version.

**2. Primary call.** The agent's main reasoning turn. Runs on the model selected by *right-sizing* (below), with behaviours selected by the user-scope classifier loaded into the system prompt. Tools available are the union of the agent's own tool set and any tools added by loaded behaviours.

**3. Critic call (conditional).** When triggered, a second model from a **different training lineage** challenges the framing of the primary response. Triggers: explicit user request, or failure-detection signals (repeated corrections, escalating frustration, looping). The critic's output is integrated into the response, not surfaced as a separate "second opinion".

### Right-sizing

A separate cheap classifier picks which model handles the *primary* call. Is this an Opus-class task, a Sonnet-class task, or a Haiku-class task? Default to the cheapest model that meets the bar; escalate only when triggers say so. Right-sizing selects from the user's configured provider set.

### Failure detection

Heuristics first — pattern matches over recent `messages` for corrections, loops, frustration markers. Classifier fallback for harder cases. Output drives the critic trigger.

### Caching

Cost reduction is a first-class concern:

- Provider-side prompt caching (Anthropic native; others where supported).
- Classifier decision caching — same lean input deterministically produces the same routing output, so identical inputs reuse the decision.
- Embedding cache (Phase 2, when vectors land).

### Behaviour storage

Behaviours and their triggers ship in plugin code, versioned with the plugin. Loaded at startup and re-indexed on plugin install/update. DB-stored mutable behaviours (self-improving prompts) are explicitly deferred — potem's version was wild and lost determinism.

---

## Subagents

First-class in core. Parent agent spawns a subagent and passes only the information it needs — not the parent's full memory.

Subagent output stays in the same conversation as a **subtree** under the parent's tool-use entry. Implemented as `messages.parent_message_id` self-FK. From the parent's perspective, a subagent invocation looks like a tool call whose response is the subtree's final output.

The classifier and critic calls *are* subagent calls — same mechanism powers routing, primary, and critique. One substrate, multiple roles.

---

## Plugins

A plugin is a full-stack contract. It ships:

- **Backend code** (Python) — handlers, tool implementations, optional MCP server exposure.
- **Frontend code** — Next.js screens and components added to the UI.
- **Migrations** — additive only, in the plugin's own folder. Core migrations run first; plugin migrations follow in load order.
- **Behaviours + triggers** — the loadable directives the agentic loop activates JIT.
- **Commands** — named, user-invokable operations dispatchable from every surface (UI, CLI, Telegram, MCP, …). See *Plugin commands* below.
- **Docs** — plugin-local.
- **Secrets handling** — declares which env vars it needs (static keys) and which `eidan.secrets_vault` entries it reads / writes (per-user dynamic creds).

**Bidirectional MCP.** Eidan exposes an MCP server (so e.g. potem, Obsidian, or another Eidan node can push data in). Eidan is also an MCP client (so plugins can wrap external MCP servers as tools). The potem → eidan data migration happens over this MCP surface, not via direct SQL.

### Plugin commands

A *command* is a named operation a plugin exposes for explicit user invocation — `/nutrition`, `/calendar add`, `/email send`. Commands are the user-typed counterpart to behaviours: a behaviour fires because a classifier matched intent; a command fires because the user typed its name. The contract is pinned in [PLUGIN COMMANDS](./019_PLUGIN_COMMANDS.md).

The load-bearing rules:

- **One handler, many surfaces.** The plugin declares a single async Python handler per command. Surface adapters (UI form, Telegram bot, CLI, inbound MCP) translate surface-native input into the handler's validated `CommandInput` and render the returned `CommandOutput` back to the user. The handler is surface-blind — it does not know which adapter invoked it. This is the architectural fix for the predecessor stack's recurring failure mode (the same operation diverging between web form and Telegram bot, with validation drifting in one of them).
- **JSON Schema is the single source of truth for arguments.** A command declares `arguments_schema` and `result_schema` per [SCHEMAS](./004_SCHEMAS.md). Validation runs once, at the core boundary, before the handler sees the input. Adapters cannot smuggle surface-specific fields past validation.
- **Per-surface metadata, not per-surface logic.** The manifest's `surfaces:` map carries per-surface hints (the React component for `ui`, the free-text prompt and parser for `telegram`, the tool slug for `mcp`). Business logic lives in the handler; surface entries are rendering and parsing hints only.
- **Commands are not behaviours.** They are peer subsystems in the manifest (`commands:` next to `behaviours:`) and peer dispatch paths in the agentic loop. A command turn has zero LLM calls on the happy path; a behaviour turn always runs the cheap classifier. See [PLUGIN COMMANDS §2](./019_PLUGIN_COMMANDS.md) for the side-by-side.
- **Core ships two surface adapters** (`ui` and `cli`); other surfaces (`telegram`, `mcp`, future `voice` / `email`) ship as plugin-registered adapters in the paid baseline or thematic bundles. New surfaces land without core changes.

**Storage and sanitisation.** Plugins live as folders under `plugins/<name>/`, flat — no tier subdirectories. Tier (`core` / `pro` / `commercial`) is declared in each plugin's `plugin.yaml` as **metadata** (bundle membership, used by the CLI). This repo carries only `tier: core` plugins; paid plugins live in **standalone sibling repos** — `eidan-charlotte`, `eidan-charles`, `eidan-sage` — and are dropped into a core install's `plugins/<name>/` directory by the eidan CLI on the operator's machine. The pre-public sanitisation step asserts no non-core plugins are present rather than stripping any.

---

## Schemas

JSON Schema is the canonical definition for every shared type. From it:

- **Frontend:** Zod schemas (Zod consumes JSON Schema; TS types inferred from Zod via `z.infer<...>`).
- **Backend:** Pydantic models (generated via `datamodel-code-generator` or equivalent).

A schema change is one edit; both runtimes regenerate.

---

## Token tracking & cost

Capture is **core**; presentation ships in the **universal paid baseline bundle**.

- The agentic loop writes one `llm_calls` row per provider call before forwarding the result. Applies equally to classifier, primary, and critic calls.
- A small in-app counter (turn cost, session cost) ships in core so the user is never surprised.
- Cost-budgeting reads `llm_calls` to enforce per-conversation or per-day caps where configured. Default: no cap.
- Dashboards, exports, per-provider/model/skill breakdowns, and cost forecasting ship as a paid-baseline plugin reading the same table. Removing the plugin never breaks capture or budgets.

---

## Repo layout

Folder-based, sanitisation-friendly. Final layout (target):

```
apps/
  cli/                  CLI interface
  web/                  Next.js frontend
  backend/              Python backend (agentic loop, MCP server/client, provider abstraction)
plugins/
  <name>/               One folder per plugin. Tier (`core`/`pro`/`commercial`)
                        declared in plugin.yaml as bundle metadata. Plugin
                        migrations live in plugins/<name>/migrations/. This
                        repo carries only `tier: core` plugins; paid plugins
                        live in private sibling repos (see docs/018 §2)
                        and are dropped here by the eidan CLI.
packages/
  schemas/              JSON Schema definitions + generators (Zod, Pydantic)
docs/
  000_ARCHITECTURE.md   This document
  001_PLUGINS.md        Plugin contract
  002_MIGRATIONS.md     Migration tiering
  018_DISTRIBUTION_AND_BUNDLES.md  Sibling-repo distribution + bundle fulfilment
migrations/
  versions/             Alembic migrations on the eidan schema. Core revisions
                        only. Where RLS / cross-cutting refinements ultimately
                        live is an open question — see docs/018 §7.
```

---

## Out of scope for Phase 1

Explicit non-goals so we don't drift:

- Vector search / `pgvector` — Phase 2.
- Real-time sync via `pg_notify` — Phase 2.
- Mobile / React Native — potential future.
- Plugin marketplace — potential future.
- DB-stored mutable behaviours (self-improving prompts) — explicitly deferred.

## Out of scope fully

- RLS and multi user
- Integrations and standalone features

---

**Maintained by:** Sielay Ltd
**Last updated:** 2026-05-13
