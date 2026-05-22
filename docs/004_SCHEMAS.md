# 004 — Schemas pipeline (JSON Schema → Zod + Pydantic)

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Schemas, Stack),
`docs/001_PLUGINS.md` (Plugin contract),
`docs/003_MEMORY_DDL.md` (memory tables that surface as DTOs)

This document specifies how Eidan keeps its data shapes in sync
between the Python backend and the TypeScript frontend. Both sides
need to agree on the wire format of every DTO that crosses the
boundary — request bodies, response envelopes, event payloads on
the bus, MCP tool inputs/outputs, plugin manifest fragments.

The rule is: **JSON Schema is the single source of truth.** Zod and
Pydantic models are generated artefacts. Neither runtime hand-writes
the shape; both consume what codegen produced.

---

## 1. Why JSON Schema as the source

The plausible alternatives are: write Pydantic first and export JSON
Schema (`model_json_schema()`); write Zod first and export with
`zod-to-json-schema`; write a neutral IDL (Protobuf, TypeSpec, OpenAPI
components) and generate both.

JSON Schema wins for Eidan because:

- It is the lingua franca of the LLM tool ecosystem (Anthropic tool
  definitions, MCP tool inputs, OpenAI function calling all consume
  JSON Schema directly). The same artefact that drives Zod and
  Pydantic also drives `tools[]` payloads — no second translation.
- It survives plugin boundaries cleanly. A plugin authored by a
  third party can ship a `.schema.json` without depending on either
  the Python or the TS toolchain.
- It is declarative and diffable. A schema review reads as data, not
  as code, which matters for the "what is this DTO?" question.
- Generation is unidirectional. Choosing Pydantic-first or Zod-first
  would make the other side a downstream that drifts whenever
  someone forgets to regenerate.

Tradeoff accepted: JSON Schema is less expressive than either Zod or
Pydantic for runtime concerns (custom refinements, computed
defaults, transformer functions). Those live in **adapter layers**
on each side (§5), not in the shared schema.

---

## 2. Schema dialect and conventions

### 2.1 Dialect

All schemas declare `$schema:
"https://json-schema.org/draft/2020-12/schema"`. Draft 2020-12 is
the dialect both `datamodel-code-generator` and `json-schema-to-zod`
target most cleanly today, and it matches what Anthropic and MCP
publish.

### 2.2 `$id`

Every schema file declares a stable `$id`:

```
https://schemas.eidan.dev/<tier>/<area>/<Name>/v<major>.json
```

- `<tier>` — `core`, `pro`, or `plugins/<plugin-name>`.
- `<area>` — coarse-grained namespace (`memory`, `auth`, `events`,
  `agentic`, ...). Matches the directory under `schemas/<tier>/`.
- `<Name>` — PascalCase type name (`Message`, `LlmCall`).
- `<major>` — integer; bumped on breaking changes (§9).

`$id` is the durable identity of a type across versions. Cross-schema
`$ref` always uses `$id` (absolute), never relative paths, so a
plugin can reference a core schema without knowing its on-disk
location.

### 2.3 `$ref` resolution

Codegen resolves `$ref` against a local registry built at codegen
time from every `.schema.json` under `packages/schemas/schemas/`.
The runtime never hits the network — the `https://schemas.eidan.dev`
namespace is purely an identity scheme, not a fetch URL.

### 2.4 Naming

- File names are `<PascalCaseName>.schema.json`. One top-level type
  per file. Nested `$defs` are allowed but represent helpers private
  to that type; cross-file reuse goes through a sibling file.
- Type names are PascalCase. Field names are `snake_case` in JSON
  (matches the Postgres column convention from `003_MEMORY_DDL.md`).
  The TS side surfaces them as `snake_case` too — no automatic
  camelCase conversion (§5.1 explains why).
- Enums use `"enum": [...]` with explicit string values. Closed sets
  only; open vocabularies use `"type": "string"` with a description.

### 2.5 Required, nullable, defaults

- A field is required iff it appears in `required[]`. Optional
  fields use `not in required[]`.
- Nullable is `{"type": ["string", "null"]}` (or equivalent union),
  never the OpenAPI 3.0 `"nullable": true` extension. Draft 2020-12
  doesn't recognise the extension and both generators choke on it.
- Defaults belong in `"default": ...`. Generators emit them as
  defaulted constructor args on the Pydantic side and as
  `.default(...)` on the Zod side.

### 2.6 What schemas live here

A schema lives in `packages/schemas/` iff it crosses a process or
package boundary:

- HTTP request / response bodies.
- WebSocket / SSE event payloads.
- MCP tool input/output (`tools[]` schemas).
- Bus event payloads (`event:<name>` triggers, §5 of `001_PLUGINS.md`).
- Plugin manifest fragments shared between loader and admin UI.

Internal-only shapes (a service-layer dataclass that never leaves
Python) stay in Python. A pure UI prop that never reaches the
backend stays in TS. Promoting an internal shape to a shared schema
is a deliberate move, not a default.

---

## 3. Tooling choices

### 3.1 Python: `datamodel-code-generator`

Codegen target: Pydantic v2 models.

- Generator: `datamodel-code-generator` (`pip install
  datamodel-code-generator`).
- Invocation:

  ```bash
  datamodel-codegen \
    --input  packages/schemas/schemas/ \
    --input-file-type jsonschema \
    --output packages/schemas/eidan_schemas/generated/ \
    --output-model-type pydantic_v2.BaseModel \
    --target-python-version 3.11 \
    --use-schema-description \
    --use-field-description \
    --use-standard-collections \
    --use-union-operator \
    --collapse-root-models \
    --disable-timestamp \
    --field-constraints \
    --snake-case-field \
    --use-default \
    --use-double-quotes
  ```

  `--disable-timestamp` keeps the generated output byte-stable across
  runs so the CI "is generated up to date?" check works (§6.3).

- Output: one `.py` per `.schema.json`, mirroring the directory tree
  under `packages/schemas/schemas/`. Each file exports a single
  Pydantic model named after the JSON Schema `title`.

#### Alternatives considered

| Tool | Why not chosen |
|------|----------------|
| `pydantic.TypeAdapter` from raw JSON Schema | No source-file generation — every consumer would re-validate the schema on import, and IDE / type-checker support would be limited to `dict` shapes. |
| `quicktype` | Multi-target generator that pulls in node and a different schema model; weaker Pydantic v2 fidelity than `datamodel-code-generator`. |
| Hand-write Pydantic, export JSON Schema | Inverts the source of truth and forces TS-side consumers to round-trip through Pydantic's emitted schema, which differs subtly from hand-written equivalents. |

### 3.2 TypeScript: `json-schema-to-zod`

Codegen target: Zod v3 schemas plus inferred TS types.

- Generator: `json-schema-to-zod` (`pnpm add -D json-schema-to-zod`).
- Invocation, per file, run from a small wrapper script under
  `packages/schemas/scripts/gen-ts.mjs` (§4.2). The wrapper:
  1. Walks `schemas/**/*.schema.json`.
  2. Builds an in-memory `$id` registry so cross-file `$ref` resolves.
  3. For each schema, calls `jsonSchemaToZod(parsed, {
     name: title, module: "esm", type: true })`.
  4. Writes the result to `src/generated/<tier>/<area>/<Name>.ts`.
  5. Emits a top-level `src/generated/index.ts` re-exporting every
     generated module.

Each generated module exports:

```ts
export const Message = z.object({ ... });
export type Message = z.infer<typeof Message>;
```

So consumers `import { Message } from "@eidan/schemas"` and get both
the runtime validator and the static type from one symbol.

#### Alternatives considered

| Tool | Why not chosen |
|------|----------------|
| `quicktype` (TS target) | Generates plain TS interfaces, no runtime validator — we still need Zod (or another runtime checker) and would end up with two tools producing overlapping output. |
| `zod-from-json-schema` | Less actively maintained than `json-schema-to-zod`; thinner support for Draft 2020-12 keywords (`prefixItems`, `unevaluatedProperties`). |
| Hand-write Zod with `z.infer` | Inverts the source of truth (same problem as hand-writing Pydantic). Acceptable for app-local shapes, not for cross-package DTOs. |
| `zod-to-json-schema` (Zod-first) | Would force the Python side to consume Zod's emitted schema, which is shaped for Zod's semantics — defaults, optional/nullable distinction — and is awkward to feed into `datamodel-code-generator`. |

### 3.3 Pinned versions

The generators evolve quickly and their output is part of our diff
budget. The repo pins exact versions:

- `datamodel-code-generator` — pinned in `packages/schemas/pyproject.toml`.
- `json-schema-to-zod` — pinned in `packages/schemas/package.json`.

Bumping a generator is its own PR. The PR title carries the version
delta; the diff is the regenerated output and nothing else.

---

## 4. Repo layout

```
packages/
└── schemas/
    ├── package.json                # pnpm package "@eidan/schemas"
    ├── pyproject.toml              # python package "eidan-schemas"
    ├── turbo.json                  # per-package overrides if needed
    ├── README.md
    │
    ├── schemas/                    # CANONICAL source of truth
    │   ├── core/
    │   │   ├── memory/
    │   │   │   ├── Conversation.schema.json
    │   │   │   ├── Message.schema.json
    │   │   │   ├── Event.schema.json
    │   │   │   ├── Knowledge.schema.json
    │   │   │   ├── Note.schema.json
    │   │   │   ├── AgentContext.schema.json
    │   │   │   ├── UserContext.schema.json
    │   │   │   └── LlmCall.schema.json
    │   │   ├── auth/
    │   │   │   └── User.schema.json
    │   │   └── agentic/
    │   │       ├── TriggerEvent.schema.json
    │   │       └── BehaviourResult.schema.json
    │   ├── pro/
    │   │   └── ...
    │   └── plugins/
    │       └── <plugin-name>/...
    │
    ├── src/                        # TS package surface
    │   ├── index.ts                # public re-exports
    │   ├── adapters.ts             # hand-written refinements (§5.1)
    │   └── generated/              # written by codegen, COMMITTED
    │       ├── index.ts
    │       ├── core/
    │       │   ├── memory/
    │       │   │   ├── Message.ts
    │       │   │   └── ...
    │       │   └── ...
    │       └── plugins/...
    │
    ├── eidan_schemas/              # Python package surface
    │   ├── __init__.py             # public re-exports
    │   ├── adapters.py             # hand-written refinements (§5.2)
    │   └── generated/              # written by codegen, COMMITTED
    │       ├── __init__.py
    │       ├── core/
    │       │   ├── memory/
    │       │   │   ├── message.py
    │       │   │   └── ...
    │       │   └── ...
    │       └── plugins/...
    │
    └── scripts/
        ├── gen-ts.mjs              # walks schemas/, drives json-schema-to-zod
        ├── gen-py.sh               # wraps datamodel-codegen
        ├── check.sh                # regen + git diff --exit-code (CI)
        └── validate.mjs            # ajv-cli over schemas/**, plus $id sanity
```

### 4.1 Generated output IS committed

`src/generated/` and `eidan_schemas/generated/` are checked into
git. Reasons:

- A fresh checkout typechecks and tests without first running
  Python tooling for TS developers, or vice versa.
- PR diffs surface generation changes alongside the schema change
  that caused them — reviewers can sanity-check the codegen output.
- A consumer of `@eidan/schemas` from npm or `eidan-schemas` from
  PyPI receives the built artefacts without needing both
  toolchains.

The cost is diff churn on schema-touching PRs. The mitigation is the
CI sync check (§6.3): a PR that edits a `.schema.json` but forgets
to regenerate fails CI immediately, before review.

### 4.2 One package, two surfaces

`packages/schemas/` is one source directory exposing two package
surfaces:

- `@eidan/schemas` — pnpm workspace package (Node + browser).
  Entry: `src/index.ts`. Build emits `dist/` (declarations + ESM).
- `eidan-schemas` — Python package built with whichever build
  backend the rest of the repo uses (assume `hatchling`). Entry:
  `eidan_schemas/__init__.py`.

Both packages share the same version number (§9). A new release of
one is a new release of the other, even if only one side's adapter
code changed, so consumers can pin a single version everywhere.

---

## 5. Adapters: where hand-written logic lives

JSON Schema cannot express:

- Custom Zod refinements (`.refine(...)` for cross-field rules).
- Pydantic `@field_validator` / `@model_validator` hooks.
- Branded types (`z.string().brand<"UserId">()`).
- Computed defaults that depend on runtime context.

These live in **adapter modules** that re-export the generated
schemas with the extra logic layered on. Consumers import the
adapter module, not the raw generated file.

### 5.1 TS adapter

```ts
// packages/schemas/src/adapters.ts
import { Message as MessageGen } from "./generated/core/memory/Message";

export const Message = MessageGen.refine(
  (m) => m.role !== "tool" || m.tool_results.length > 0,
  { message: "tool messages must carry at least one tool_result" },
);
export type Message = z.infer<typeof Message>;
```

The public `src/index.ts` re-exports `Message` from `adapters.ts`,
not from `generated/`. The generated symbol is still reachable as
`MessageRaw` for callers that need the unrefined version (e.g.
debugging tools).

Field names stay `snake_case` end-to-end. Auto-camelCasing the TS
side would diverge from the JSON wire shape, double the surface
area of the type system (a snake-case DTO + a camelCase view
model), and create a quiet trap where developers serialise an
object with the wrong key names. Components that want a
camelCase-flavoured view do the conversion explicitly at the read
site.

### 5.2 Python adapter

```python
# packages/schemas/eidan_schemas/adapters.py
from pydantic import model_validator
from .generated.core.memory.message import Message as MessageGen

class Message(MessageGen):
    @model_validator(mode="after")
    def _tool_messages_have_results(self) -> "Message":
        if self.role == "tool" and not self.tool_results:
            raise ValueError("tool messages must carry at least one tool_result")
        return self
```

The public `eidan_schemas/__init__.py` re-exports `Message` from
`adapters.py`. Subclassing the generated model (rather than wrapping
it) keeps the type usable wherever the generated model was — FastAPI
body annotations, response models, MCP tool argument types.

### 5.3 What does NOT belong in adapters

- Business logic. An adapter validates wire-format invariants
  ("this combination of fields is impossible"). It does not enforce
  policy ("this user is not allowed to send this message").
- Storage logic. Persistence concerns belong in the service /
  repository layer, not in the schema package.
- Anything that depends on application configuration. Adapters
  must remain importable in isolation, including during codegen.

---

## 6. Build wiring

The repo uses pnpm workspaces + Turborepo on the JS side and a
top-level Python workspace on the Python side. Both pipelines
converge on `packages/schemas/` via the targets described here.

### 6.1 Turbo task graph

`packages/schemas/turbo.json` (or the root `turbo.json`'s entry for
this package) declares:

```jsonc
{
  "pipeline": {
    "@eidan/schemas#gen": {
      "inputs": ["schemas/**/*.json", "scripts/**", "package.json"],
      "outputs": ["src/generated/**", "eidan_schemas/generated/**"],
      "cache": true
    },
    "@eidan/schemas#build": {
      "dependsOn": ["@eidan/schemas#gen"],
      "outputs": ["dist/**"]
    },
    "@eidan/schemas#check": {
      "dependsOn": ["@eidan/schemas#gen"],
      "cache": false
    },
    "build": { "dependsOn": ["@eidan/schemas#build", "^build"] },
    "typecheck": { "dependsOn": ["@eidan/schemas#gen", "^typecheck"] }
  }
}
```

The key relationship: every downstream JS package that depends on
`@eidan/schemas` automatically waits for `@eidan/schemas#gen`. There
is no "I forgot to regenerate" failure mode at local dev time — turbo
picks up the schema-input change and re-runs codegen before any
typecheck or build that consumes it.

### 6.2 Root scripts

In the repo root `package.json`:

```json
{
  "scripts": {
    "schemas:gen":   "turbo run @eidan/schemas#gen",
    "schemas:build": "turbo run @eidan/schemas#build",
    "schemas:check": "turbo run @eidan/schemas#check"
  }
}
```

And `@eidan/schemas#gen` chains the two generators:

```json
{
  "scripts": {
    "gen:ts":   "node scripts/gen-ts.mjs",
    "gen:py":   "bash scripts/gen-py.sh",
    "gen":      "pnpm gen:ts && pnpm gen:py",
    "check":    "bash scripts/check.sh",
    "validate": "node scripts/validate.mjs",
    "build":    "tsc -p tsconfig.build.json"
  }
}
```

`gen:py` is invoked from the JS side intentionally — Turbo owns the
top-level orchestration so a single command runs the entire
pipeline. The shell script wraps a Python virtualenv invocation; it
does not require contributors to install Python globally if they
work only on the TS side, because CI is the enforcer (§6.3).

### 6.3 CI sync check

The "did you regenerate?" check is one CI job:

```bash
# packages/schemas/scripts/check.sh
set -euo pipefail

pnpm --filter @eidan/schemas validate     # ajv-cli over schemas/**
pnpm --filter @eidan/schemas gen          # regenerates into the tree
git diff --exit-code -- \
  packages/schemas/src/generated \
  packages/schemas/eidan_schemas/generated
```

A schema-edit PR that forgets to regenerate produces a non-empty
diff and fails with a clear "generated outputs are out of date,
run `pnpm schemas:gen`" message. A PR that hand-edits a file under
`generated/` fails for the same reason.

This job is required for merge. It runs in parallel with the unit
test job and is fast (codegen for the entire tree is well under a
minute).

### 6.4 Pre-commit hook

A pre-commit hook (`lint-staged` config under `packages/schemas/`)
runs `pnpm schemas:gen` if any `*.schema.json` is staged, and stages
the regenerated files alongside. This keeps commits self-contained
locally; the CI check is the backstop for contributors who skip
hooks.

Per repo policy, contributors do not pass `--no-verify` to bypass
the hook — if regen fails, fix the schema, not the hook.

---

## 7. Dev workflow

### 7.1 Adding a new type

1. Author the schema under the appropriate directory:

   ```
   packages/schemas/schemas/core/memory/Reminder.schema.json
   ```

   ```json
   {
     "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$id": "https://schemas.eidan.dev/core/memory/Reminder/v1.json",
     "title": "Reminder",
     "description": "A scheduled nudge surfaced by the agentic loop.",
     "type": "object",
     "additionalProperties": false,
     "required": ["id", "user_id", "due_at"],
     "properties": {
       "id":      { "type": "string", "format": "uuid" },
       "user_id": { "type": "string", "format": "uuid" },
       "due_at":  { "type": "string", "format": "date-time" },
       "body":    { "type": ["string", "null"], "default": null }
     }
   }
   ```

2. Run codegen:

   ```bash
   pnpm schemas:gen
   ```

3. Inspect the generated files under `src/generated/core/memory/`
   and `eidan_schemas/generated/core/memory/`. If you need
   refinements, add them to `adapters.ts` / `adapters.py` and
   re-export from the package index.

4. Use it from either side:

   ```ts
   import { Reminder } from "@eidan/schemas";
   const parsed = Reminder.parse(payload);
   ```

   ```python
   from eidan_schemas import Reminder
   parsed = Reminder.model_validate(payload)
   ```

5. Commit the schema, the regenerated files, and any adapter edits
   together. The CI sync check passes because the tree matches.

### 7.2 Editing an existing type

Edit the `.schema.json`, run `pnpm schemas:gen`, review the diff in
the generated files (this is your sanity check on what the change
actually means at the type level), commit. If the change is
breaking, see §9 — you may need to ship a `v2` alongside, not in
place.

### 7.3 Local validation

`pnpm schemas:validate` runs `ajv-cli` over every `.schema.json` to
catch malformed schemas before codegen wastes time on them. The
validator also enforces project-local rules:

- `$id` is present and matches the file path.
- `title` is present and equals the filename stem.
- `additionalProperties: false` on every object (closed-world by
  default; opt out per-schema with a comment justifying it).
- No `"nullable": true` (OpenAPI extension, §2.5).

### 7.4 Consuming from a plugin

A plugin that ships its own `.schema.json` files lives under
`packages/schemas/schemas/plugins/<plugin-name>/`. The plugin's
backend and frontend depend on `@eidan/schemas` and `eidan-schemas`
respectively, the same as core code; there is no separate per-plugin
codegen pipeline. This is the deliberate consequence of "one package,
two surfaces" (§4.2): plugins extend the shared catalogue rather
than vending parallel ones.

A third-party plugin developed out-of-tree may run its own codegen
against its own JSON Schemas; it interoperates by `$ref`-ing
`https://schemas.eidan.dev/core/...` `$id`s, which Eidan's loader
resolves against the bundled core schemas at install time.

---

## 8. Runtime use

### 8.1 Backend

- FastAPI routes annotate request and response bodies with the
  Pydantic models from `eidan_schemas`. Pydantic produces the
  OpenAPI document directly from these models.
- The bus (`ctx.bus` in `001_PLUGINS.md §2.2`) validates event
  payloads against the matching schema on publish; subscribers
  receive parsed instances.
- MCP tool input schemas (`mcp.tools[]` in `001_PLUGINS.md §1.1`)
  are produced by calling `Model.model_json_schema()` on the input
  type, so the externally advertised schema is byte-for-byte the
  artefact that drove codegen, not a hand-written second copy.

### 8.2 Frontend

- API client uses Zod schemas to parse responses at the network
  boundary. Inferred types flow through the rest of the app.
- Form libraries (`react-hook-form` + `@hookform/resolvers/zod`)
  consume the same schemas, so client-side validation and
  server-side validation agree by construction.
- Component prop types that mirror a DTO use `z.infer<typeof
  Message>` rather than redeclaring a parallel interface.

### 8.3 Validation locations

Validate at boundaries, not in transit:

- Inbound HTTP → Pydantic (server) and Zod (client) at the network
  edge.
- Bus publish/subscribe → validate on publish; trust on receive.
- DB read → trust the DB (the migration is the schema of record
  there); validate only when crossing a network boundary again.

---

## 9. Versioning and breaking-change policy

### 9.1 Package versioning

`@eidan/schemas` and `eidan-schemas` are versioned together with
SemVer:

- **patch**: documentation-only edits, generator bumps that produce
  byte-stable output.
- **minor**: additive changes — new schemas, new optional fields,
  new enum values, widening a type union.
- **major**: any breaking change — see §9.2.

### 9.2 What is breaking

A change is breaking if it makes a previously valid payload
invalid, or changes a parsed value's TS / Python type:

- Removing a field.
- Renaming a field.
- Making an optional field required.
- Narrowing a type (`string` → `string` with a stricter pattern,
  removing an enum value, removing a union arm).
- Changing the type of an existing field.
- Setting `additionalProperties: false` on a schema that previously
  allowed extras.

Non-breaking:

- Adding an optional field with a default.
- Adding a new enum value to a producer-side schema, as long as
  consumers handle unknown enum values gracefully (the consumer-side
  schema treats the enum as open via a fallback union arm).
- Widening a type union.
- Loosening a pattern.

### 9.3 How a breaking change ships

Per-type, not per-package. Instead of mutating
`Message.schema.json` in place:

1. Author `Message.schema.json` as the new shape. Its `$id` is
   bumped: `.../Message/v2.json`. Its `title` is still `Message`.
2. Move the old shape to `MessageV1.schema.json`. Its `$id` stays
   `.../Message/v1.json`, its `title` becomes `MessageV1`. This
   preserves the old `$id` so external consumers that reference it
   continue to resolve.
3. The package exports both `Message` (the new shape) and
   `MessageV1` (the legacy shape) for one minor release cycle. Code
   sites migrate at their own pace.
4. The next major release removes `MessageV1`.

This is mirrored by the database migration cadence in
`002_MIGRATIONS.md §6.1`: destructive schema-side changes also
proceed in two releases.

### 9.4 The "evolving in place" exception

Within a pre-`1.0` package, breaking changes MAY be made in place
with a single-version bump (e.g. `0.4.x → 0.5.0`). The same
operational rule applies: the breaking change is its own PR, the
CHANGELOG entry calls it out by name, and any in-tree consumer is
updated in the same PR. After `1.0`, breakage requires the §9.3
deprecation dance.

### 9.5 CHANGELOG

`packages/schemas/CHANGELOG.md` is hand-maintained. Each entry
lists the schemas touched, the kind of change (additive / breaking
/ generator-bump), and the version it lands in. Reviewers check
that a PR with a breaking change has a corresponding CHANGELOG
entry before merging.

---

## 10. Reserved for later specs

Out of scope here, deferred:

- **Embedding schema diffs in the DB migration pipeline.** When a
  `messages.tool_calls` jsonb shape changes, the schema package
  reflects it but there is no automatic backfill. A future spec
  defines the contract.
- **Cross-plugin schema visibility and namespacing.** Plugins can
  currently `$ref` core schemas but the registry of which plugin
  publishes which schema is informal. A registry spec is a
  follow-up.
- **Schema-driven test fixture generation.** Producing valid sample
  payloads from `.schema.json` for integration tests
  (`jsf`/`json-schema-faker`-style) is plausible but unspecified.
- **Codegen for non-Python, non-TS targets** (Go, Rust) — should
  Eidan ever ship a non-Python backend service or a non-TS client,
  the same source-of-truth tree feeds those generators too.
