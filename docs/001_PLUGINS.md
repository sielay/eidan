# 001 — Plugin Contract

Status: Approved

Owner: Core

Related: [ARCHITECTURE](./ARCHITECTURE.md) (Plugins, Agentic loop, Secrets), [DISTRIBUTION AND BUNDLES](.docs/018_DISTRIBUTION_AND_BUNDLES.md) (sibling-repo distribution), [PLUGIN COMMANDS](./019_PLUGIN_COMMANDS.md) (`commands[]`, surface adapters, handler protocol)

This document specifies the full-stack plugin contract for Eidan. A
plugin is a self-contained, versioned unit that can extend the host
along any of the following axes:

- backend Python code (HTTP endpoints, services, agent tools)
- frontend Next.js code (routes, components, settings panels)
- database migrations
- behaviours and triggers in the agentic loop
- commands — named user-invokable operations dispatchable
  across every surface (UI, CLI, Telegram, MCP);
  see [PLUGIN COMMANDS](./019_PLUGIN_COMMANDS.md)
- an optional MCP server exposed to external clients

A plugin lives entirely under a single directory. All plugin
directories sit flat under `plugins/<name>/` regardless of tier;
the tier is metadata declared in the manifest (§1.1) rather than
encoded in the path. Eidan discovers plugins by walking
`plugins/<name>/` and loads them according to the lifecycle in §8.

---

## 1. Manifest

Every plugin directory MUST contain a `plugin.yaml` at its root. The
manifest is the single source of truth for identity, dependencies,
permissions, and extension points. The host validates it on load;
plugins that fail validation are rejected, not partially loaded.

### 1.1 Schema

```yaml
# plugin.yaml
schema: 1                       # manifest schema version (integer)

name: example-notes             # globally unique slug, [a-z0-9-]
version: 0.3.1                  # semver 2.0.0
display_name: Example Notes     # human-facing
description: >
  One-paragraph summary shown in the plugin admin UI.

tier: core                      # core | pro | commercial
license: AGPL                   # SPDX identifier
authors:
  - name: Jane Doe
    email: jane@example.com

# --- dependency graph -----------------------------------------------------

depends_on:                     # other plugins required at load time
  - name: core-auth
    version: ">=0.2.0,<1.0.0"   # PEP 440 / npm-style range
  - name: core-storage
    version: "^0.4"

host:                           # required host capabilities
  eidan: ">=0.1.0"
  python: ">=3.11"
  node: ">=20"

# --- declared configuration surface --------------------------------------

env:                            # env vars the plugin reads
  - name: EXAMPLE_NOTES_BASE_URL
    required: true
    description: Public base URL for the notes service.
  - name: EXAMPLE_NOTES_DEBUG
    required: false
    default: "0"

vault:                          # secret entries the plugin reads
  - key: example_notes.api_key
    required: true
    description: API key for the upstream notes provider.
  - key: example_notes.webhook_secret
    required: false

# --- extension points ----------------------------------------------------

backend:
  entrypoint: example_notes.plugin:Plugin   # module:ClassName
  routes_prefix: /api/plugins/example-notes # mount point under the host

frontend:
  package: ./web                            # path to JS package (npm-style)
  routes:
    - path: /notes                          # mounted under the host app
      component: ./web/src/pages/Notes.tsx
  components:                               # contributed shared components
    - slot: dashboard.widget
      component: ./web/src/widgets/Recent.tsx
  settings_panel: ./web/src/settings/Panel.tsx

migrations:
  dir: ./migrations
  driver: alembic                           # alembic | sql

behaviours:                                 # agentic-loop behaviours
  - id: notes.summarise_on_create
    trigger: event:notes.created
    handler: example_notes.behaviours:summarise_on_create
  - id: notes.daily_digest
    trigger: cron:0 7 * * *
    handler: example_notes.behaviours:daily_digest

commands:                                   # user-invokable, cross-surface; full contract in 019
  - name: notes.add
    description: Create a note from a one-line summary and optional body.
    arguments_schema: ./schemas/notes_add.args.schema.json
    result_schema:    ./schemas/notes_add.result.schema.json
    handler: example_notes.commands:add_note
    mcp_tool: true                          # also expose as an MCP tool
    surfaces:
      ui:
        component: ./web/src/commands/NoteAddForm.tsx
        confirm_label: "Save note"
      telegram:
        prompt: "Title + (optional) body — first line is the title."
        parser: regex
        regex_module: example_notes.parsers:title_body

mcp:                                        # optional MCP server
  enabled: true
  name: example-notes
  entrypoint: example_notes.mcp:server
  transport: stdio                          # stdio | sse
  tools:
    - notes.search
    - notes.create
```

### 1.2 Validation rules

- `name` MUST be unique within an installation and is the
  fully-qualified identifier used in logs, DB rows, and the
  `plugin_<name_underscored>` schema. The directory `plugins/<name>/`
  MUST equal the manifest `name`.
- `version` MUST be strictly increasing across installed releases.
- `tier` MUST be one of `core`, `pro`, `commercial`. It is
  metadata identifying which bundle a plugin belongs to (used by
  the CLI for display/grouping and by release sanitisation —
  [REPO SANITISATION](./016_REPO_SANITISATION.md)). Access control 
  is enforced at the GitHub repo level, not at runtime via the manifest.
  The parent directory is not used to derive the tier.
- `depends_on` MUST form a DAG; cycles are a fatal load error.
- Every `env` and `vault` entry the runtime resolves at load time
  MUST be declared here. Reading an undeclared env var or vault key
  raises `UndeclaredAccessError`; this is checked at runtime and
  enforced in CI via the lint command.
- `commands[]` entries are validated per
  [PLUGIN COMMANDS §3.4](./019_PLUGIN_COMMANDS.md). The combined
  command + behaviour namespace MUST be collision-free across all
  active plugins: a `commands[].name` MUST NOT equal any other
  command `name` or any `behaviours[].id` already registered. This
  prevents `/foo` being ambiguous between a typed command and an
  OFFER chip pointing at a behaviour called `foo`.
- All file paths in the manifest are relative to the plugin root.
  Paths MUST NOT escape the plugin root.

`eidan admin plugin lint [<name>|--all]` is the CI-side gate. For
each target plugin it:

1. Validates `plugin.yaml` against the JSON Schema (reusing
   `eidan_backend.plugins.manifest.load_manifest`, which also
   enforces the `plugins/<name>/` directory ↔ `manifest.name`
   match).
2. Statically scans the plugin's Python sources for the obvious
   undeclared-access shapes:
   - `os.environ["X"]`, `os.environ.get("X", ...)`, and
     `os.getenv("X", ...)` with a literal first argument — warned
     when `X` is not in `env:`.
   - `ctx.secret.get(user_id, "X")` / `.set(user_id, "X", ...)` /
     `.delete(user_id, "X")` with a literal second argument —
     warned when `X` is not in `vault:`.
   Dynamic accesses (`os.environ[var]`, `ctx.secret.get(user_id,
   computed_key)`) cannot be resolved statically; runtime catches
   them via `UndeclaredAccessError` per the rule above.
3. If `pyproject.toml` exists, checks `[project].name` equals the
   snake_case of `manifest.name` (or the hyphenated form — both PEP
   621 spellings are accepted).

Any finding fails the run with a non-zero exit code so CI gates
merges automatically. The lint never descends into `migrations/`,
`tests/`, or `web/`; those directories may legitimately reference
process state in ways the runtime never invokes.

---

## 2. Backend entry point

### 2.1 Package layout

A plugin's Python code lives in a single importable package whose
name matches `name` with hyphens replaced by underscores. Example:

```
plugins/example-notes/
├── plugin.yaml                   # declares tier, version, deps, extension points
├── pyproject.toml                # plugin-local deps, optional
├── example_notes/
│   ├── __init__.py
│   ├── plugin.py                 # declares Plugin class
│   ├── routes.py                 # FastAPI router(s)
│   ├── services.py
│   ├── behaviours.py
│   └── mcp.py                    # optional, if mcp.enabled
├── migrations/                   # plugin's private Alembic history (§4)
│   └── ...
├── web/
│   └── ...
└── tests/
    └── ...
```

The package is installed into the host's virtualenv at load time via
`pip install -e .` against the plugin root. Plugins that omit
`pyproject.toml` are still importable but cannot declare third-party
Python dependencies and MUST rely only on packages already provided
by the host.

### 2.2 The `Plugin` class

`backend.entrypoint` MUST resolve to a class with this shape:

```python
# example_notes/plugin.py
from eidan.plugins import PluginBase, PluginContext

class Plugin(PluginBase):
    name = "example-notes"

    async def on_install(self, ctx: PluginContext) -> None:
        """One-shot setup. Runs once, before first activation.

        Idempotent: MUST tolerate being re-run after a failed install.
        Migrations run separately (see §4) — do not run DDL here.
        """

    async def on_activate(self, ctx: PluginContext) -> None:
        """Called every time the host starts with the plugin enabled.

        Register routers, behaviour handlers, MCP tools, etc.
        """
        ctx.register_router(self.build_router())
        ctx.register_behaviours(self.behaviours())

    async def on_deactivate(self, ctx: PluginContext) -> None:
        """Called on host shutdown or when the plugin is disabled.

        Release in-process resources. MUST NOT mutate persistent
        state — that belongs in `on_uninstall`.
        """

    async def on_uninstall(self, ctx: PluginContext) -> None:
        """Tear down persistent state owned by this plugin.

        Migrations run separately in the reverse direction.
        """

    async def health(self, ctx: PluginContext) -> dict:
        """Optional readiness probe surfaced in /admin/plugins."""
        return {"ok": True}
```

`PluginContext` is the only sanctioned interface to the host. It
exposes:

- `ctx.env[KEY]` and `ctx.secret(KEY)` — declared access only.
- `ctx.db` — async session scoped to the plugin's schema namespace.
- `ctx.bus` — pub/sub for the agentic loop's event stream.
- `ctx.register_router(router)` — mount a FastAPI router under
  `backend.routes_prefix`.
- `ctx.register_behaviours(handlers)` — register behaviours declared
  in the manifest.
- `ctx.register_mcp(server)` — when `mcp.enabled`.
- `ctx.logger` — structured logger pre-tagged with `plugin=<name>`.

Direct imports from `eidan.internal.*` are forbidden and rejected at
lint time. Anything not exposed via `PluginContext` or the
documented `eidan.plugins.*` surface is private to the host.

### 2.3 Lifecycle ordering

For a single plugin the host invokes hooks in this order:

```
on_install   (once, before first activate; after migrations up)
on_activate  (each host start, after deps' on_activate)
on_deactivate (each host stop, before deps' on_deactivate)
on_uninstall (once, before migrations down, after on_deactivate)
```

Across plugins: install/activate run in topological order over the
`depends_on` DAG. Deactivate/uninstall run in reverse topological
order.

---

## 3. Frontend mounting

The host runs Next.js (App Router). Plugin frontend code is
contributed as an npm-style package referenced by `frontend.package`.
At load time the host:

1. Symlinks the plugin's `web/` directory into the host's plugin
   workspace.
2. Registers each `frontend.routes[]` entry as a dynamic route under
   the host's app, namespaced to `/p/<plugin-name>/...` unless the
   path begins with `/`, in which case it is mounted at the root
   (subject to collision rules, §3.3).
3. Loads `frontend.components[]` into the named slots exposed by the
   host. Slots are stable extension points (e.g. `dashboard.widget`,
   `command-palette.action`, `settings.section`) and are documented
   in the host's component-slot catalogue.

### 3.1 Component contract

Plugin components MUST:

- be default exports of TSX files
- accept a typed `PluginProps<T>` shape with `ctx` (read-only host
  context: current user, theme, feature flags) and slot-specific
  `data`
- be tree-shakable (no top-level side effects)

### 3.2 Build

The host runs `pnpm install && pnpm build` in the plugin's `web/`
during install. Production assets are served from the host process;
there is no separate frontend deploy step per plugin.

### 3.3 Route collision

Two plugins claiming the same root-mounted path is a fatal load
error. Namespaced routes (`/p/<name>/...`) cannot collide by
construction.

---

## 4. Migrations

### 4.1 Layout

```
plugins/example-notes/migrations/
├── env.py                 # alembic env, generated from template
├── script.py.mako
└── versions/
    ├── 0001_init.py
    ├── 0002_add_tags.py
    └── 0003_index_created_at.py
```

Each plugin owns a private migration history co-located with its
code. Plugin tables live in a Postgres schema named
`plugin_<name_underscored>`. The host guarantees that schema exists
before any of the plugin's migrations run, and registers the
plugin's `migrations/` directory as an Alembic `version_locations`
entry (with branch label `plugin_<name>`) at install / activation
time. Deactivated plugins are not added to the path, so their
history is dormant rather than re-applied.

`migrations.driver` may be:

- `alembic` (recommended) — full Alembic env under `migrations/`.
- `sql` — flat `versions/NNNN_name.sql` files applied in lexical
  order. Reversibility requires a paired `NNNN_name.down.sql`.

### 4.2 Load order

For install / upgrade:

1. Topologically sort plugins by `depends_on`.
2. For each plugin in order: apply all pending migrations to head.
3. Run `on_install` (first time) or skip (upgrade).
4. Run `on_activate`.

For uninstall:

1. Run `on_deactivate`, then `on_uninstall`.
2. Migrate the plugin's history down to base.
3. Drop the `plugin_<name>` schema if empty.

Migrations from different plugins MUST NOT reference each other's
tables by raw name. Cross-plugin data exchange goes through the
declared backend API of the owning plugin.

---

## 5. Behaviours and triggers

A *behaviour* is a function the agentic loop invokes in response to
a *trigger*. Behaviours are registered declaratively in the manifest
under `behaviours[]` and resolved to handlers at activation.

### 5.1 Trigger grammar

```
trigger := "event:" <event-name>
         | "cron:" <cron-expr>
         | "webhook:" <slug>
         | "schedule:" <iso-8601-interval>
         | "agent:" <tool-name>
```

- `event:<name>` — fires when the named event hits the bus.
  Event names are dot-namespaced (`notes.created`).
- `cron:<expr>` — standard 5-field cron in the host's timezone.
- `webhook:<slug>` — the host exposes
  `POST /api/webhooks/<plugin>/<slug>` and routes the body to the
  handler.
- `schedule:<interval>` — fires on a fixed interval after activation.
- `agent:<tool-name>` — the behaviour is registered as a tool the
  agentic loop may call directly; `<tool-name>` is the externally
  visible name.

### 5.2 Handler signature

```python
async def summarise_on_create(
    ctx: PluginContext,
    trigger: TriggerEvent,
) -> BehaviourResult: ...
```

`TriggerEvent` carries the payload, idempotency key, and originating
trace ID. `BehaviourResult` lets the handler emit follow-up events
on `ctx.bus`. The host guarantees at-least-once delivery; handlers
MUST be idempotent on `trigger.idempotency_key`.

### 5.3 Failure policy

Handler exceptions are caught, logged, and retried with exponential
backoff up to `behaviours.retries` (default 3). Permanent failures
land in a dead-letter table the admin UI surfaces.

### 5.4 Relationship to commands

Commands (`commands[]`, see
[PLUGIN COMMANDS](./019_PLUGIN_COMMANDS.md)) are a peer subsystem,
not a kind of behaviour. The two share `plugin.yaml` real estate
and persist into the same `messages` table but are dispatched
differently: a behaviour fires because a classifier matched the
user's intent; a command fires because the user typed `/<name>`.
Commands skip the scope classifier entirely, validate input
**once** at the core boundary, and dispatch to a single
surface-blind async handler shared across every surface (UI, CLI,
Telegram, MCP). A behaviour MAY surface an OFFER chip whose accept
action is a command invocation; a command MAY trigger behaviours
on its result via the agent-router classifier. See
[PLUGIN COMMANDS §2](./019_PLUGIN_COMMANDS.md) for the side-by-side
and the permitted/forbidden interaction patterns.

---

## 6. Folder placement

```
plugins/
├── example-notes/     # tier: core         (lives in this repo)
├── strava/            # tier: pro          (lives in a paid bundle repo; dropped here by the CLI)
└── acme-billing/      # tier: commercial   (lives in a commercial bundle repo)
```

Plugin directories sit flat under `plugins/`. The directory name MUST
equal the manifest `name`; no nesting, no tier subdirectories. The
loader reads each `plugin.yaml` to determine the tier. The manifest's
`tier:` field is the source of truth and governs:

- which paid bundle a plugin belongs to (used by the CLI to display
  and group installed plugins, and by the operator to reason about
  what to back up or remove)
- which channels the plugin may publish to (the commercial registry
  vs. the open one)
- visibility in the admin UI

License-gating doesn't runs at activation time — access is enforced
upstream at GitHub repo level. Possession of the plugin source (which
the operator obtained by cloning a private bundle repo they paid for)
is the license. See [DISTRIBUTION AND BUNDLES](./018_DISTRIBUTION_AND_BUNDLES.md).

The open repository carries only `tier: core` plugins. Paid plugins
live in standalone private repos and are dropped into an operator's
`plugins/<name>/` directory by the eidan CLI. The release
sanitisation runbook [REPO_SANITISATION](./016_REPO_SANITISATION.md) does not strip plugins by tier because non-core plugins are not 
present in this repo to begin with.

A missing or malformed `tier:` is a fatal load error.

---

## 7. MCP server exposure

When `mcp.enabled` is true the host treats the plugin as the owner
of a named MCP server. At activation the host:

1. Imports `mcp.entrypoint` and expects an `mcp.server.Server`
   instance (or a factory returning one).
2. Registers the server under `mcp.name` in the host's MCP
   directory.
3. Exposes it to external clients via the configured transport
   (`stdio` for local clients, `sse` for HTTP).

`mcp.tools[]` is the public allowlist of tool names. Tools defined
in code but not listed in the manifest are not exposed externally.
This keeps the externally observable surface declarative and
reviewable.

A plugin MAY register the same handler as both an `agent:` behaviour
trigger (internal) and an `mcp.tools[]` entry (external) — the two
are independent registrations of the same function.

---

## 8. Install / load / unload semantics

### 8.1 Install (new plugin)

1. Source acquired into `plugins/<name>/` (manual drop, registry
   pull, or git submodule). The directory name MUST equal the
   manifest `name`.
2. `eidan plugins install <name>` is invoked (CLI or admin UI):
   1. Parse and validate `plugin.yaml`.
   2. Resolve `depends_on`; fail if any required plugin is missing
      or version-incompatible.
   3. Verify all declared env vars and vault entries are present
      (or have defaults).
   4. Run `pip install -e .` for backend; `pnpm install && pnpm
      build` for frontend.
   5. Apply migrations to head.
   6. Call `on_install`.
   7. Mark plugin `installed` in the host's `plugins` table.

### 8.2 Activate (every host start)

For each `installed && enabled` plugin, in topological order:

1. Import backend entrypoint and instantiate `Plugin`.
2. Call `on_activate(ctx)`.
3. Mount routers, behaviour handlers, MCP server, frontend routes.
4. Mark `active`.

### 8.3 Deactivate

Inverse topological order:

1. Unmount routers and frontend routes.
2. Stop MCP server.
3. Unregister behaviour handlers (in-flight handlers are allowed to
   finish under a bounded grace period; default 30s).
4. Call `on_deactivate(ctx)`.

A plugin may be deactivated without uninstalling — its data and
migrations stay in place; only the runtime registrations are torn
down.

### 8.4 Uninstall

1. Deactivate if active.
2. Call `on_uninstall`.
3. Migrate plugin history down to base.
4. Drop `plugin_<name>` schema if empty (host refuses if not empty
   unless `--force-drop` is passed).
5. Remove backend package from venv; remove frontend symlink and
   built assets.
6. Mark `uninstalled`. The directory itself is left in place; the
   operator removes it manually.

### 8.5 Upgrade

Upgrade is uninstall-less: a new version drop-in followed by
`eidan plugins upgrade <name>` which re-runs install steps 1–5 but
skips `on_install` and instead calls an optional `on_upgrade(ctx,
from_version)` if defined.

### 8.6 State machine

```
not-present ──install──▶ installed ──activate──▶ active
                            ▲                      │
                            │                      │
                            └─────deactivate───────┘
                            │
                          uninstall
                            │
                            ▼
                       not-present
```

Each transition is atomic from the operator's perspective: a failure
at any step rolls the plugin back to the prior state and surfaces a
diagnostic in the admin UI.

---

## 9. Reserved for later specs

The following are intentionally **out of scope** for this document
and will be specified in follow-ups:

- Plugin signing and supply-chain verification.
- The plugin registry protocol (push, pull, version negotiation).
- Cross-plugin data-sharing primitives beyond declared HTTP APIs.
- Sandboxing for untrusted plugins (currently: trusted-only).
