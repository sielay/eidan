# CLAUDE.md

Notes for Claude (and other coding agents) working in this repo. This
is the contributor's quick map; `docs/ARCHITECTURE.md` and the
numbered specs under `docs/` are authoritative when this file
disagrees with them.

## What eidan is

A single-deployable, plugin-extensible personal agent host. Python on
the server, Next.js on the client, Postgres for memory. Core ships
open source. Paid functionality ships as **standalone sibling
repos** — one per bundle — that drop into a core install's
`plugins/` directory via the eidan CLI. There are no forks of this
repo. See `docs/018_DISTRIBUTION_AND_BUNDLES.md` for the canonical
distribution model, `README.md` for the elevator pitch, and
`docs/ARCHITECTURE.md` for the architectural overview.

The product ships across six sibling repos:

- **This repo (`eidan`)** — core host, schemas, core plugins. AGPL.
- **Universal paid baseline bundle** — calendar, IMAP, multiuser
  + RLS, cost dashboards. Auto-installed with any paid bundle.
- **Three thematic paid bundles** — one per persona (lifestyle,
  business, coding). Mix-and-match. Each is its own private repo.
- **Landing repo** — marketing site + Stripe checkout + GitHub
  fulfilment. Holds all monetisation code so this repo stays
  clean of business logic.

Canonical repo names and roles are pinned in
`docs/018_DISTRIBUTION_AND_BUNDLES.md §2`; this document does not
repeat them per the §8 forbidden-string posture. The five non-core
repos are private. The universal paid baseline is not a separately
purchasable SKU; it is installed as a dependency whenever any
thematic bundle is installed.

## Top-level layout

```
apps/
├── web/         # Next.js (App Router). Plugin frontends mount here.
└── backend/     # Python / FastAPI. Agentic loop, MCP, providers, persistence.

packages/
└── schemas/     # JSON Schema → Zod + Pydantic codegen.

plugins/
└── <name>/      # One folder per plugin. Tier declared in plugin.yaml.
                 # Plugin migrations live under <name>/migrations/.
                 # This repo only carries `tier: core` plugins.
                 # Paid bundles live in private sibling repos
                 # (see docs/018 §2) and are dropped in here by
                 # the eidan CLI on an operator's machine.

migrations/      # Alembic migrations on the eidan schema.
                 # Core migrations only. RLS / index / trigger
                 # migrations no longer live here — that question is
                 # open. See docs/018 §7.

docs/            # Numbered specs (001 plugins, 002 migrations, ...).
```

## Components

### `apps/web` — Next.js host UI

App Router. Single deployable for the user-facing UI. Plugin
frontends mount into named slots and dynamic routes
(`docs/001_PLUGINS.md §3`). Working assumption: shadcn/ui + Tailwind.
Phase 1 surface is pinned in `docs/014_UI_SURFACE.md`.

The UI is a **thin client over the backend's authoritative state**.
Counters, lists, chips — every visible datum is derived from a
backend payload pinned in the relevant spec. There is no second
source of truth for backend-owned data on the client.

### `apps/backend` — Python / FastAPI host

The Python backend. Designed to run multi-instance (Fly.io, Pi plus
cloud node, etc.) with Postgres as the shared source of truth; work
that needs a single owner elects a leader rather than assuming one
process. Owns:

- the agentic loop and turn runner (`docs/005_AGENTIC_LOOP.md`)
- eager persistence of every conversation row (§1.1 of the same)
- the plugin loader and lifecycle (`docs/001_PLUGINS.md §2, §8`)
- the provider abstraction (`docs/007_PROVIDER_ABSTRACTION.md`)
- the inbound MCP server and outbound MCP client
  (`docs/013_MCP_SURFACE.md`)
- auth via Supabase JWT validation against cached JWKS
  (`docs/011_AUTH_FLOW.md`)
- cost capture and budget enforcement
  (`docs/010_COST_BUDGETING.md`)

### Memory — Postgres `eidan` schema

Memory is **not** a TypeScript package. It is a Postgres schema owned
by core migrations (`migrations/`) and accessed by `apps/backend`.
The shape is pinned in `docs/003_MEMORY_DDL.md`. Core tables:

| Table             | Purpose                                                  |
|-------------------|----------------------------------------------------------|
| `conversations`   | Thread container that messages, notes, and llm_calls FK into. |
| `messages`        | Append-only turn log, tree-shaped via `parent_message_id`. |
| `events`          | Calendar-like items: due, occurred, recurring, status.   |
| `knowledge`       | Curated, skill-tagged markdown with source attribution.  |
| `notes`           | Working memory written by an agent during a conversation. |
| `agent_context`   | Per-agent identity: code defaults + user overrides.      |
| `user_context`    | Durable user facts (identity, goals, constraints, prefs, projects). |
| `llm_calls`       | Per-provider-call telemetry: tokens, cost, latency, error. |

Naming notes for anyone with muscle memory from the predecessor
stack:

- `events` — **not** `episode` / `episodes`.
- `user_context` — **not** `owner_context`.
- `captures` — **dropped**; working memory is now `notes`, durable
  user facts are `user_context`, and skill-tagged markdown is
  `knowledge`.
- `knowledge`, `notes`, and `llm_calls` are new first-class tables.

Plugin data lives in private `plugin_<name>` schemas owned by the
plugin's own migrations (`docs/001_PLUGINS.md §4`). Core code never
reads them.

### `packages/schemas` — JSON Schema → Zod + Pydantic

One source directory, two language surfaces. JSON Schema is the
**single source of truth** for every DTO that crosses a process
boundary (HTTP, WS/SSE, MCP tools, bus payloads, plugin manifest
fragments). Codegen produces:

- TypeScript: `@eidan/schemas` via `json-schema-to-zod`. Exports both
  the Zod schema and the inferred TS type from the same symbol.
- Python: `eidan-schemas` via `datamodel-code-generator` →
  Pydantic v2 models.

Generated outputs live under `packages/schemas/src/generated/` and
`packages/schemas/eidan_schemas/generated/`. **They are committed.**
CI re-runs codegen and fails on any diff. Hand-edits to generated
files are rejected. Refinements that JSON Schema cannot express
(cross-field validators, branded types, `@model_validator`) live in
sibling `adapters.{ts,py}` modules and are re-exported as the public
surface.

Field names are `snake_case` end to end; the TS side does not
auto-camelCase. See `docs/004_SCHEMAS.md` for the full pipeline and
versioning policy.

### Plugins (`plugins/<name>/`)

A plugin is a self-contained, versioned unit declared by a single
`plugin.yaml`. Plugins are stored flat under `plugins/`; the `tier:`
field in the manifest (`core` / `pro` / `commercial`) is metadata —
which bundle a plugin belongs to, used by the CLI to display and
group installed plugins. Tier is metadata only; it does not affect
the on-disk layout. A plugin can contribute:

- backend Python code (FastAPI routers, services, agent tools)
- frontend Next.js code (routes, components, settings panels)
- Alembic migrations (in a private `plugin_<name>` schema), located
  at `plugins/<name>/migrations/` next to the code
- behaviours and triggers in the agentic loop
- an optional MCP server exposed to external clients

The `Plugin` class implements `on_install` / `on_activate` /
`on_deactivate` / `on_uninstall` and interacts with the host only via
`PluginContext`. Direct imports from `eidan.internal.*` are forbidden
and rejected at lint time. The contract is pinned in
`docs/001_PLUGINS.md`.

External integrations are **paid-bundle plugins**, so they live
in the appropriate sibling bundle repo — not in this repo.
Cross-cutting infrastructure plugins shared by every paid plan
(calendar via CalDAV / Google Calendar, IMAP/email, multiuser
RLS on `eidan.*`, cost dashboards) live in the universal paid
baseline bundle. Persona-specific integrations live in the
thematic bundles (e.g. Strava in the lifestyle bundle). The
generic substrate they land into (`events`, `knowledge`,
`notes`) is in core.

## Tech stack

- **Backend:** Python 3.11+, FastAPI, Alembic, Pydantic v2,
  Anthropic / OpenAI / Gemini / Mistral / Ollama provider SDKs.
- **Frontend:** Next.js (App Router), TypeScript, Zod, shadcn/ui +
  Tailwind (working assumption).
- **Data:** Postgres 13+ (uses `gen_random_uuid()`, `tsvector`,
  generated columns, partial indexes).
- **Auth:** Supabase Auth on the edge; Python validates JWTs locally
  against cached JWKS — no remote auth call on the hot path.
- **Schemas:** JSON Schema 2020-12 as the source of truth;
  `json-schema-to-zod` (TS) and `datamodel-code-generator` (Python)
  as the generators.
- **Build orchestration:** pnpm workspaces + Turborepo on the JS
  side; a top-level Python workspace on the Python side. Turbo's
  `@eidan/schemas#gen` task is a dependency of every downstream
  build, so "did you regenerate?" is not a failure mode at local dev
  time.
- **MCP:** bidirectional. Host exposes an inbound server; plugins
  wrap upstream MCP servers as outbound clients
  (`docs/013_MCP_SURFACE.md`).

## Common tasks

These map to the plugin contract. Most non-trivial work in eidan
lands inside a plugin, not in the core host.

### Add a new DTO that crosses a process boundary

1. Author `<Name>.schema.json` under
   `packages/schemas/schemas/<tier>/<area>/`. Include `$schema`,
   `$id`, `title`, and `additionalProperties: false`. Field names
   `snake_case`.
2. Run `pnpm schemas:gen` (or let Turbo run it via the dependent
   task graph).
3. If you need a refinement JSON Schema cannot express, add it to
   `adapters.ts` / `adapters.py` and re-export from the package
   index.
4. Commit the schema, the regenerated files under `generated/`, and
   any adapter edits together. The CI sync check passes when the
   tree matches.

Breaking changes ship per-type, not per-package — bump the `$id` to
`/v2.json`, keep the old shape as `<Name>V1.schema.json` for one
release cycle. See `docs/004_SCHEMAS.md §9`.

### Add a Python dependency

1. Add the package to the relevant workspace member's
   `pyproject.toml` (`apps/backend/pyproject.toml`,
   `apps/cli/pyproject.toml`, etc.) — or run `uv add <pkg>` in
   that directory, which edits the same file.
2. Run `uv lock` at the **repo root**. The workspace lockfile is
   shared across all members; refreshing it here keeps every
   member's resolution consistent.
3. Commit `pyproject.toml` and `uv.lock` together. The
   `uv-lock-check` pre-commit hook + the `uv-lock-check` CI
   workflow both block a commit / PR that updates one without
   the other. The Fly image builds with `uv sync --frozen`, so a
   missed lock refresh otherwise only fails at deploy time.

`uv` itself is pinned to `0.11.15` in `infra/fly/Dockerfile`,
`.github/workflows/python-tests.yml`, and in the
`uv-lock-check.yml` workflow. The devcontainer currently copies
`ghcr.io/astral-sh/uv:0.5`; update `.devcontainer/Dockerfile` as
well if local container behavior needs to match CI/Fly when upgrading.

### Add a new plugin

1. Create `plugins/<name>/` with a `plugin.yaml`. Declare `tier:` in
   the manifest (`core` / `pro` / `commercial`) — the directory is
   flat, the tier is metadata.
2. Declare backend / frontend / migrations / behaviours / mcp
   extension points the plugin actually uses. Omit the rest.
3. Implement `Plugin(PluginBase)` with `on_install` / `on_activate`
   etc. Interact with the host only via `PluginContext`.
4. If the plugin has its own data, add migrations under
   `plugins/<name>/migrations/` (Alembic preferred). Plugin tables
   live in the `plugin_<name>` schema; the host creates the schema
   before migrations run and registers the plugin's migration
   directory with Alembic at activation time.
5. If the plugin exposes tools externally, set `mcp.enabled: true`
   and list the externally visible tools in `mcp.tools[]`. Tools
   defined in code but not listed are not exposed.

The contract — manifest schema, package layout, lifecycle, MCP — is
pinned in `docs/001_PLUGINS.md`.

### Add a core memory table

Rare. Core migrations live under `migrations/versions/` and use
Alembic. New columns / tables on `eidan.*` MUST:

- be defined in core. (Thematic bundles are plugins-only and own
  their own `plugin_<name>` schemas; they do not add tables to
  `eidan.*`. RLS and other cross-cutting refinements on core
  tables live in the universal paid baseline bundle. The shape of
  the host-schema-migration extension point in that bundle is
  still being settled — see `docs/018 §7`.)
- carry `created_at` / `updated_at` per `003 §1.2`, soft-delete
  conventions per `003 §1.3` if the row is user-visible, and
  partial indexes on `deleted_at IS NULL` for read paths.
- be exposed (if they cross a process boundary) via a JSON Schema
  in `packages/schemas/schemas/core/memory/`.

### Add a behaviour to the agentic loop

Behaviours are declared in `plugin.yaml` under `behaviours[]` and
resolved to Python handlers at activation. The trigger grammar
(`event:`, `cron:`, `webhook:`, `schedule:`, `agent:`) is pinned in
`docs/001_PLUGINS.md §5.1`. Handlers MUST be idempotent on
`trigger.idempotency_key` — the host guarantees at-least-once
delivery, not exactly-once.

### Wrap an external MCP server

The plugin declares the upstream connection in its manifest. At
activation, the host opens the connection, lists the upstream tools,
and registers them into the agentic loop's tool surface alongside
in-process tools. To the primary model the wrapped tools are
indistinguishable from local ones. See `docs/013_MCP_SURFACE.md §4`
(outbound) for the lifecycle and the error-normalisation envelope.

## Code-review-graph MCP tools

This repo is exposed via the `code-review-graph` MCP server. Prefer
graph tools (`semantic_search_nodes`, `query_graph`,
`detect_changes`, `get_impact_radius`, `get_review_context`) over
Grep/Glob/Read when exploring code, scoping a change, or reviewing a
diff. The graph is faster, cheaper in tokens, and surfaces structural
context — callers, dependents, test coverage — that file scanning
cannot.

Fall back to Grep/Glob/Read only when the graph does not cover what
you need (e.g. reading the literal contents of a markdown spec).

## Conventions

- Field names are `snake_case` everywhere — JSON wire, Postgres
  columns, TS DTOs, Python attributes. No camelCase view layer.
- Generated files (under any `generated/` directory) are committed
  and CI-checked. Do not hand-edit; re-run codegen instead.
- Soft-delete is `deleted_at timestamptz`. Read paths default-filter
  on `deleted_at IS NULL`; indexes used by the read path are partial
  on the same predicate.
- `llm_calls` is immutable. Retention is a separate purge job.
- Pre-commit hooks regenerate schemas when `*.schema.json` is
  staged. Do not pass `--no-verify` to bypass them; fix the source
  instead.

## No-fork policy

**Operators MUST be able to run, deploy, customise, and upgrade
eidan from a vanilla `git clone` of upstream, without ever
editing a tracked file in this repo.** A fork is a one-way door
for an operator — once they fork, every upstream update becomes a
merge they have to resolve, and any in-fork edits leak to the
mirror if they ever contribute back.

The bar applies to every operator-facing surface we design:
deployment recipes, CI templates, plugin install, runtime
config, dev-loop instructions. If a feature's documented happy
path is "add this file to the repo" or "edit `pyproject.toml` to
add your dependency," that's a design failure — back up and find
a shape that doesn't force the fork.

How this lands in practice:

- **Per-deploy choices come from env vars, secrets, CLI flags,
  and build args** — not from edits to tracked files. Examples:
  Fly app name + region live in the operator's own gitignored
  `fly.toml` (copied once from `infra/fly/fly.toml.example`),
  paid bundles install via `EIDAN_BUNDLES` + `EIDAN_PLUGIN_SOURCE`
  build args, plugin discovery root via `EIDAN_PLUGINS_DIR`.
- **Tracked artefacts ship generic and consumed as-is.** A
  `Dockerfile` we ship has zero per-operator strings in it. A
  config we ship is either fully generic or has a `.example`
  suffix and a copy-first workflow. Operator-private CI lives in
  the operator's own ops repo, not in `.github/workflows/` of
  upstream.
- **Plugins are dropped in, not patched in.** The plugin
  contract (`docs/001_PLUGINS.md`) and the bundle distribution
  model (`docs/018_DISTRIBUTION_AND_BUNDLES.md`) mean a plugin's
  full surface area is its own directory under `plugins/<name>/`.
  Adding a plugin never requires editing core code.
- **Runtime extension points before code edits.** If a new
  capability needs a fixed list (allowed origins, supported
  providers, registered behaviours), express it as something the
  operator passes in (env var, plugin manifest, CLI flag) rather
  than something they append to a tracked source file.

When reviewing or designing a feature, the gut check is: *can a
single operator-internal change live entirely in (a) the
operator's environment, (b) the operator's own ops/bundle repo,
or (c) a gitignored config — without touching this repo's git
history?* If the answer is no, the design needs another pass.

This rule is parallel to **Commit hygiene** below: that one
keeps operator-internal junk OUT of the public mirror; this one
keeps the public mirror designed so operators never need to put
their junk in.

## Commit hygiene

**Never commit, stage with intent to commit, push, or open a PR
without explicit operator confirmation in the current turn.** This
repo is the AGPL public core; anything committed here is one merge
away from the public mirror (`docs/016_REPO_SANITISATION.md`).
Bundle-private code, scratchpads, half-formed designs, draft
specs, and operator-internal notes belong in sibling repos or in
gitignored files — never in core history.

Specifically:

- Default to "don't commit" unless the operator's current-turn
  message explicitly asks for it ("commit this", "open a PR",
  "push"). A prior turn's authorisation does NOT carry forward.
- Edits to tracked files are fine without confirmation; the
  confirmation gate is the `git commit` / `git push` /
  `gh pr create` boundary.
- Scratchpads, plans, and working notes go in gitignored paths
  (e.g. `plugins/_BUILD_PLAN.md`, the `/plugins/*` allowlist in
  `.gitignore`). Don't promote them to tracked files
  speculatively.
- If a commit looks justified but the operator hasn't asked, stop
  and ask — list the staged files and the proposed message, and
  wait. Same rule for PRs.
- This rule is stricter than the agent's default "ask before
  destructive operations" because a single commit to the wrong
  repo can leak canary / paid-bundle material to the public
  mirror. Treat every `git commit` here as load-bearing.

## Release shape

Public mirror is a **flat commit per tagged release** — this repo's
day-to-day history does not propagate. The runbook
(`docs/016_REPO_SANITISATION.md`) strips operator-internal artefacts
(`*_INTERNAL.md` files, `Dev notes` blocks, private release scripts,
sensitive `.env.example` entries) before the public flat commit
lands. Paid-bundle and landing code is not stripped here because it
is not in this repo to begin with — it lives in the five private
sibling repos enumerated in `docs/018 §2`. The forbidden-string
grep is the hard release gate.
