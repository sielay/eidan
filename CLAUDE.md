# CLAUDE.md

Notes for Claude (and other coding agents) working in this repo — the quick map. `README.md` (the
elevator pitch) and the source under `packages/` are authoritative when this file disagrees.

## What eidan is

A self-hosted, plugin-extensible personal agent OS, built as **plugins on the matbot runtime**
(`external/matbot`, a vendored Apache-2.0 submodule — a thin isomorphic-TypeScript agent engine).
Eidan adds the product layer: relational Postgres memory, the interop surfaces, jobs, auth, and the
deploy story. Postgres (the `eidan` schema) is the source of truth.

Everything ships **open source (AGPL-3.0-or-later)**. Thematic **bundles** (coding/business/
lifestyle) are just more matbot plugins, folded into this repo as opt-in `packages/<name>` (tracked,
AGPL, not in `CORE_PLUGINS` — a node loads them only when configured). The product isn't sold as
paid bundles; monetisation is creator-style (education + consulting + an optional hosted tier). The
plugin/service interface is still the contract between core and bundles — they just live in one repo.

## Top-level layout

```
external/matbot/      # the agent runtime (Apache-2.0 git submodule). Don't edit; contribute upstream.
packages/<name>/      # eidan plugins (AGPL). One TypeScript module each, exporting `const plugin`.
apps/web/             # reference Next.js UI (front door): proxy for chat/auth + Next->Postgres dashboards.
migrations/           # the eidan.* schema as ordered SQL + a Node migrate runner (@eidandev/migrate).
infra/fly-mb/         # the deployable host image (Dockerfile + fly config + deploy README).
matbot.yaml.example   # host config template (the real matbot.yaml is gitignored).
```

The plugins:

| Package | Role |
|---|---|
| `@eidandev/storage-postgres` | matbot StorageBackend: `Store<Session>` + `FileStore` over `eidan.*`, keen append-only, ambient-principal RLS |
| `@eidandev/vault-postgres` | matbot `Vault` backend over `eidan.secrets_vault` (Fernet-at-rest, per-user); `EidanSecrets` service + value-free `secret` tool |
| `@eidandev/secrets-api` | secure secrets HTTP API (`:8092`): the LLM-free write path the Settings UI calls (`GET catalog`/metadata, `PUT`/`DELETE`) |
| `@eidandev/memory` | knowledge + notes; `EidanMemory` service + remember/recall tools |
| `@eidandev/jobs` | delegation work-queue (`eidan.jobs`); bundles register kind handlers via `JobHandlers` |
| `@eidandev/frontend-agui` | chat surface over AG-UI (`POST /api/turn`) for the Next.js UI |
| `@eidandev/auth` | JWT `WebPrincipalResolver` — per-request identity |
| `@eidandev/mcp-server` | inbound MCP server (expose eidan tools to external agents) |
| `@eidandev/a2a-server` | inbound A2A agent (expose eidan to other agents) |
| `@eidandev/notify` | topic-routed outbound notifications (slack/telegram) |
| `@eidandev/llm-calls` | per-call cost/token ledger → `eidan.llm_calls` |
| `@eidandev/procedures` | sandboxed agent-authored procedures: run JS that composes an allowlisted tool subset in an isolated-vm, ephemeral or promoted to the knowledge graph |

## The plugin & service model

A plugin is one TypeScript module exporting `export const plugin: MatbotPluginSpec` (see matbot's
`docs/PLUGINS.md`). Plugins extend the host through matbot's seams: **tools**, **hooks**
(screen/contribute/toolcall/toolresult/followup), a **StorageBackend**/**KnowledgeIndex**,
**providers**, **frontends**, and the **service registry**.

Cross-plugin collaboration goes through the **service registry**, keyed by interface name:
`await services.register('EidanMemory', impl)` then `services.EidanMemory?.…`. Each side augments
`MatbotServices` (the matbot pattern; the string key matches at runtime). Eidan registers
`StorageBackend`, `EidanMemory`, `JobHandlers`, `WebPrincipalResolver`, `Notify`, `LlmCalls`.

Memory lives in Postgres under `eidan` (conversations, messages, events, knowledge, notes,
agent_context, user_context, llm_calls, artifacts, jobs). Persistence is **keen** — the inbound
user message hits the store before the provider call (matbot's runner), and messages are
append-only rows. Plugin-private data goes in a `plugin_<name>` schema the plugin owns.

## Tech stack

- **Runtime:** [matbot](https://github.com/MatAtBread/matbot) (TypeScript, Node 24+ native
  type-strip — no build step; plugins run their `.ts` directly).
- **Data:** Postgres 13+ (`gen_random_uuid()`, `tsvector`, generated columns, partial indexes, bytea).
- **LLM:** matbot provider adapters (Anthropic, OpenAI-compat) — plain `fetch`, no SDKs.
- **Interop:** MCP (in via `mcp-server`, out via matbot's mcp client), AG-UI (`frontend-agui`),
  A2A (`a2a-server`).
- **Deploy:** `infra/fly-mb` container image → Fly / Pi / any node; Postgres shared as the source of truth.

## Conventions

- **Erasable-only TypeScript.** Node's strip-only runtime rejects non-erasable syntax — **no
  TypeScript parameter properties** (`constructor(private x: T)` → declare the field + assign in the
  body), no enums, no namespaces. `tsc` *allows* these, so only a real host run catches them.
- **SPDX header on every new source file:** `SPDX-License-Identifier: AGPL-3.0-or-later` (TS/JS block
  comment). `License Header Check` enforces it on additions; the only exempt path is the vendored
  `external/matbot/**` (Apache-2.0) and vendored third-party under `packages/*/vendor/**` (their own
  licence, listed in `.github/license_header_exempt.txt`). Bundle code is AGPL like the rest of core.
- `snake_case` on the wire and in Postgres. (The AG-UI camelCase carve-out is matbot's chat wire,
  handled inside `frontend-agui`.) matbot's `Message.content` round-trips losslessly via the
  `content_blocks` jsonb column; the legacy `content`/`tool_calls`/`tool_results` columns are
  denormalised projections kept for queryability.
- Soft-delete is `deleted_at timestamptz`; read paths filter `deleted_at IS NULL` with partial
  indexes. `llm_calls` is immutable.
- Defer to matbot's own `external/matbot/CLAUDE.md` for the runtime's design principles (no provider
  SDKs, AsyncIterables, the typed hooks, the ambient `Principal`, the service registry).

## Common tasks

**Add a plugin** — create `packages/<name>/` with `package.json` (`name: @eidandev/<name>`,
`matbotRuntime: ["node"]`, `exports: { ".": "./src/index.ts" }`, link `@matatbread/matbot-plugin-api`),
a strict `tsconfig.json`, and `src/index.ts` exporting `const plugin`. List it in `matbot.yaml`.

**Add / change a core memory table** — drop a new `migrations/sql/NNNN_name.sql` (additive;
`created_at`/`updated_at`, soft-delete + partial indexes for user-visible rows) and apply it with
`pnpm --filter @eidandev/migrate migrate` (idempotent; tracked in `eidan._migrations`). The matbot
backend reads the new columns.

**Expose a capability to other plugins** — `await services.register('YourService', impl)`, augment
`MatbotServices` with `YourService?: YourService`, consume via `services.YourService?.…`. Name the
key after the interface.

## Code-review-graph MCP tools

This repo is exposed via the `code-review-graph` MCP server. Prefer graph tools
(`semantic_search_nodes`, `query_graph`, `detect_changes`, `get_impact_radius`,
`get_review_context`) over Grep/Glob/Read when exploring or reviewing. Fall back to file tools only
when the graph doesn't cover what you need.

## Gitignored-config policy

**Operators MUST be able to run, deploy, customise, and upgrade eidan without ever editing a tracked
file in this repo.** Every operator-private datum lands in a gitignored path, so a `git pull` always
fast-forwards cleanly and a contribution PR never carries private config across the boundary.

- **Per-deploy choices come from env vars, secrets, and gitignored config** — the real `matbot.yaml`,
  `.data/`, `.plugins/`, `fly.toml`, and `.env` are gitignored; only `*.example` is tracked.
- **Tracked artefacts ship generic** — the `infra/fly-mb/Dockerfile` has zero per-operator strings.
- **An operator's own plugins drop in via config, not by patching core** — a third-party/private
  plugin is added through `matbot.yaml` + the deploy CLI, never by editing tracked source. (Eidan's
  own thematic bundles live in-tree under `packages/<name>`, AGPL + opt-in.)
- **Runtime extension before code edits** — a fixed list (providers, routes, exposed tools) is an env
  var / config the operator passes in, not an append to tracked source.

Gut check: *can a single operator-internal change live entirely in their environment, a gitignored
path, or their own private repo — without touching this repo's tracked history?* If not, redesign.

## Commit hygiene

**Never commit, stage with intent to commit, push, or open a PR without explicit operator
confirmation in the current turn.** This repo is the AGPL public core; anything committed here is one
merge from the public mirror. Operator-private deploy config, secrets, scratchpads, half-formed
designs, and internal notes belong in gitignored files — never in tracked core history.

- Default to "don't commit" unless the operator's current-turn message asks for it. A prior turn's
  authorisation does NOT carry forward.
- Edits to tracked files are fine without confirmation; the gate is the `git commit` / `git push` /
  `gh pr create` boundary.
- If a commit looks justified but the operator hasn't asked, stop and ask — list the staged files and
  the proposed message, and wait.
- Stricter than the default "ask before destructive ops": one commit to the wrong repo can leak
  operator-private deploy config or secrets to the public mirror. Treat every `git commit` here as
  load-bearing.

## Release shape

The public mirror is a **flat commit per tagged release** — this repo's day-to-day history does not
propagate. The forbidden-string grep (`release/forbidden-strings.txt`) is the hard release gate: it
blocks operator-private deploy names and secrets from reaching the public mirror. The thematic
bundles are AGPL and live here; only the marketing **landing** site and operator-private deploy
config (`.env`, `eidan.deploy.json`) stay out of this repo.
