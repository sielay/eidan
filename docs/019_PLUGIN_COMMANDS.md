# 019 — Plugin command registration across surfaces

Status: Draft (§1 — §4 committed; §5 onwards to come)
Owner: Core
Related: `docs/ARCHITECTURE.md` (Plugins, Agentic loop),
`docs/001_PLUGINS.md` (§1 Manifest, §2 PluginContext, §5
Behaviours and triggers),
`docs/005_AGENTIC_LOOP.md` (§1.1 Eager persistence, §5 the turn),
`docs/006_BEHAVIOURS_TRIGGERS.md` (§2 Behaviour data shape, §7
AUTO vs OFFER),
`docs/013_MCP_SURFACE.md` (Inbound MCP tools),
`docs/014_UI_SURFACE.md` (§4.5 Composer, §10
`command-palette.action` slot),
`docs/004_SCHEMAS.md` (per-DTO JSON Schema authoring),
`docs/018_DISTRIBUTION_AND_BUNDLES.md` (`eidan-pro` and the
thematic bundles)

This document specifies the **plugin command** subsystem — how a
plugin registers a named operation (e.g. `/calendar add`,
`/email send`, `/nutrition`) **once** and dispatches it from
**any** surface (the web UI composer, a Telegram chat, voice, an
inbound MCP client, …) without duplicating its business logic.

It fills the gap left by `001_PLUGINS.md` (which declares
`behaviours[]` but no peer `commands[]` concept) and by
`014_UI_SURFACE.md §10` (which declares the
`command-palette.action` slot but defers it to Phase 2). It pins:

- What a command **is** in a plugin manifest, distinct from a
  behaviour (§2) and from an MCP tool (§5 reserved).
- The handler protocol every command implements — surface-blind,
  Pydantic-validated, eagerly persisted (§4).
- The surface-adapter protocol that lets an open-ended set of
  surfaces (UI, Telegram, voice, MCP) dispatch into the same
  handler with no per-surface conditionals in plugin code (§5
  reserved).
- How commands cohabit with behaviours, MCP tools, and the
  agentic loop without overlap or precedence ambiguity (§2; MCP
  exposure reserved in §5).

The motivating problem is concrete: in the predecessor stack
(`potem`) the web UI form and the Telegram bot diverged for the
same operation. Validation lived in two places; one drifted; data
landed inconsistently. This spec is the architectural fix —
**one handler, many surfaces, single validation pass at the
core boundary**.

Out of scope (deferred to follow-ups; see §5):

- The Telegram bot's wire protocol, polling/webhook lifecycle, and
  per-user auth. Telegram is a paid-bundle adapter shipped from
  the paid baseline bundle (see `docs/018 §2`); this doc only pins
  the contract the adapter consumes.
- Voice and email surfaces. Both are speculative — the surface-
  adapter protocol (§5 reserved) leaves them open without
  specifying their adapters.
- Command versioning when the argument schema changes; tracks
  the JSON Schema versioning policy in `004 §9`.
- The eidan CLI's command-registry inspection commands (`eidan
  command list`, etc.); land alongside the CLI itself.

---

## 1. Vocabulary

A small fixed cast carries the rest of the document. Where a term
overlaps with an existing one in `006_BEHAVIOURS_TRIGGERS.md` (for
example "handler", "registry"), the meaning here is the
command-specific specialisation — the row in the table calls out
the difference.

| Term                       | Meaning                                                                                                                                              |
|----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Command**                | A named operation a plugin exposes for explicit invocation. Identified by `name` (e.g. `nutrition`, `calendar.add`, `email.send`), invoked via a leading slash on every text surface (`/nutrition …`). Declarative metadata + a single Python callable. |
| **Surface**                | A user-facing channel that can carry a command invocation: the web UI composer, a Telegram chat, an email mailbox, a voice transcript, an inbound MCP tool call. Identified by a short slug (`ui`, `telegram`, `voice`, `email`, `mcp`). Core ships only the `ui` surface; the rest are registered by bundle plugins. |
| **Adapter**                | The piece of code that turns surface-native input into a `CommandInput` DTO and turns a `CommandOutput` back into a surface-native reply. One adapter per surface, registered through the plugin manifest (§5 reserved). |
| **`CommandInput`**         | The validated, surface-blind argument payload the handler receives. A Pydantic v2 model generated from the command's `arguments_schema` (JSON Schema, `004_SCHEMAS.md`). Identical shape regardless of which adapter produced it. |
| **`CommandContext`**       | The ambient invocation context the handler receives alongside `CommandInput`: `user_id`, `conversation_id`, `originating_surface`, `idempotency_key`, vault accessor, DB session. Provided by core, not by the adapter. |
| **`CommandOutput`**        | The handler's return value: a small structured envelope with a `status` (`ok` / `error`), a `message` (human-readable, surface-renderable), and an optional `data` payload (typed against the command's `result_schema`, JSON Schema). Surface adapters render this back to the user. |
| **Command handler**        | The single Python callable a command resolves to (`module:function`). Distinct from a *behaviour handler* (`006 §2.2`): a behaviour handler runs because a classifier matched it; a command handler runs because the user typed `/<name>`. |
| **Command registry**       | The in-process table the host populates from every active plugin's `commands[]` at activation time. Keyed on `name`; collisions across plugins are a fatal activation error. Snapshot per turn so reinstalls mid-turn do not change dispatch (registration mechanism reserved in §5). |
| **Surface-adapter registry** | The peer table for surface adapters, keyed on surface slug (`ui`, `telegram`, …). At most one adapter per slug; core ships `ui`; `telegram` and `mcp` are registered by the paid baseline bundle; thematic-bundle adapters are possible but expected to be rare. |
| **Slash invocation**       | The wire convention every text surface follows: the literal `/`, the command name, then surface-specific argument text. The composer's parser, the Telegram update handler, and the email subject-line parser all funnel into the same registry lookup. |
| **`mcp_tool: true`**       | An opt-in manifest flag on a command that auto-exposes it as a tool on the plugin's MCP server, using the command's `arguments_schema` as the tool input schema (MCP surface reserved in §5). |

### 1.1 The two canonical examples threaded through this doc

Two commands are used end-to-end as worked examples; both live in
the paid baseline bundle (see `docs/018 §2`) because both are
cross-cutting paid infrastructure available to every paid plan.

- **`/calendar add`** — "create a calendar event". Owns
  `plugin_calendar.events` (the plugin's private table; not to be
  confused with core `eidan.events`). Adapters: `ui` renders a
  full date/time/recurrence form; `telegram` parses one-line
  free text via a classifier; `mcp` exposes the same operation
  to any inbound MCP client. Handler in
  `example_calendar.commands:add_event`.
- **`/email send`** — "send an email from the user's configured
  IMAP/SMTP account". Owns nothing in core schema; reads
  per-user SMTP creds from the native vault (`docs/012_SECRETS.md`).
  Adapters: `ui` renders a full compose form with attachments;
  `telegram` parses `to / subject / body` from a short script;
  `mcp` exposes the same. Handler in
  `example_imap.commands:send_email`.

Both are paid-bundle plugins shipping in the paid baseline bundle.
The core contract pinned here does not depend on either example —
they are included to keep §3 onwards (the manifest shape, the
handler protocol, the adapter protocol) concrete rather than
abstract.

### 1.2 What is *not* a command

Three near-neighbours that share surface or shape but are
deliberately not commands, called out to keep the boundaries
clean:

- **A behaviour (`006`).** Behaviours are classifier-selected
  directives loaded JIT into the primary call's system prompt
  and tool set. The user does not type a behaviour name; the
  model may or may not invoke its tools. Commands are
  user-explicit, classifier-free. The distinction is the spine
  of §2.
- **An MCP tool from the agentic loop's point of view.** A tool
  exposed via `mcp.tools[]` in the manifest (`001 §7`) is available
  to the primary call as one option among many. A command happens
  to *also* be exposable as an MCP tool (§5 reserved), but a tool
  that exists only for the model's use, not for `/<name>`
  invocation, is not a command.
- **A plugin's HTTP route.** Plugins can mount FastAPI routers
  under `backend.routes_prefix` (`001 §2`). Those routes serve
  the UI and other clients; they are not commands. A command's
  *adapter* may dispatch via such a route, but the command itself
  is the named operation, not its transport.

---

## 2. Commands vs behaviours

The two subsystems coexist by design. This section pins the
distinction so future code, future docs, and future plugins do
not blur them — the predecessor stack's deepest UX confusion came
from treating "the user typed something" and "the agent decided
something" as the same dispatch event.

### 2.1 The doctrine line

> **A behaviour fires because a classifier matched the user's
> intent. A command fires because the user typed its name.**

Behaviours (`006`) live behind a numeric-index classifier call
(`006 §5`); the user does not know they exist, does not name
them, and does not authorise their tools individually. AUTO mode
loads them silently; OFFER mode surfaces an accept/dismiss chip
(`006 §7`).

Commands live in front of the classifier entirely. The user types
`/calendar add tomorrow 14:00 dentist`; the turn runner parses
the slash, looks up `calendar.add` in the command registry, and
dispatches to the handler — **the scope classifier never runs for
that turn's primary intent**, because there is no intent to
classify. The user already said exactly what to do.

### 2.2 Side-by-side

| Aspect                             | Behaviour (`006`)                                                            | Command (this doc)                                                              |
|------------------------------------|-------------------------------------------------------------------------------|----------------------------------------------------------------------------------|
| **Who decides it fires**           | Behaviour classifier (cheap LLM, numeric index out).                          | The user — by typing `/<name>`.                                                 |
| **Where it lives in the manifest** | `behaviours[]`                                                                | `commands[]`                                                                    |
| **Surface visibility**             | Invisible (AUTO) or a chip (OFFER); never named by the user.                  | Named by the user; appears in `/`-autocomplete in every text surface.           |
| **Identity to the loop**           | A system-prompt stanza + a set of tools, scoped to one turn.                  | A dispatch — the turn becomes "run handler X with input Y".                     |
| **Validation timing**              | Tool inputs validated when the model calls a tool.                            | Input validated **once, at the surface boundary**, before the handler runs.     |
| **Persistence shape**              | Per-tool-call `messages` row (`005 §5.5`).                                    | A `messages` row of type `command_invoked` + the handler's `command_output`.    |
| **Failure UX**                     | Tool errors are part of the primary call's tool loop; the model recovers.     | Handler errors return a `CommandOutput{status: "error", …}` rendered by the adapter directly — no model recovery loop. |
| **Cost profile**                   | At least one classifier call per turn (cheap) + the primary call.             | Zero LLM calls in the happy path. (Some surfaces, e.g. Telegram, *parse* free text with a cheap classifier; that is adapter-internal, reserved in §5.) |
| **Idempotency contract**           | Behaviour handlers are idempotent on `trigger.idempotency_key` (`001 §5.1`).  | Command handlers are idempotent on `CommandContext.idempotency_key`, derived from `(user_id, command_name, input_hash, surface, surface_event_id)`. |

### 2.3 Interaction — they can compose

The two subsystems are independent but not isolated. Two
permitted interaction patterns:

- **A command can trigger behaviours on its result.** The
  agent-router classifier (`005 §5.10`) runs after the handler
  completes, reading the `CommandOutput.message` as the "primary
  response" for routing purposes. Example: `/email send` succeeds
  → the agent-router classifier matches an `intent:` trigger and
  schedules a follow-up subagent that drafts a calendar
  follow-up reminder. The command itself stays surface-blind; the
  router decides whether to add anything on top.
- **A behaviour can recommend a command via OFFER.** A behaviour
  whose stanza ends in "consider offering the user `/calendar
  add`" registers an OFFER chip whose accept action is exactly
  the command invocation. The chip carries the command name and
  a pre-filled `CommandInput`; accepting dispatches as if the
  user had typed `/calendar add …`. This keeps the
  behaviour/command boundary clean — the behaviour does not
  *do* the work; it suggests the command that does.

What is **not** permitted:

- A command cannot be invoked silently by the agentic loop as a
  side-effect of a behaviour. If the model wants to send an
  email mid-turn, it calls the `email.send` *MCP tool* (which the
  command opts into via `mcp_tool: true`, MCP surface reserved in §5), not the
  command. The distinction is whose name appears in the
  `messages` row: a tool call is the model's action, a command
  invocation is the user's.
- A behaviour cannot share a `name` with a command. The host's
  activation-time check rejects collisions across both registries
  (the rule in `001 §1.2` on plugin-name uniqueness extends to
  this combined namespace; registration mechanism reserved in §5).

### 2.4 Why not "everything is a command"

The temptation is to collapse behaviours into commands — "the
classifier just picks which command to run". Rejected, because
the two have fundamentally different cost profiles, persistence
shapes, and failure semantics (§2.2). Collapsing them either
forces commands to pay the classifier cost on every turn (wasteful
when the user typed an explicit name) or forces behaviours to
have user-visible names (defeating the JIT-loading point of
`006`). They are peer concepts, not the same concept at different
abstraction levels.

---

## 3. Manifest surface

A command is declared by an entry in a plugin's `plugin.yaml`
under a new top-level `commands[]` block. The block sits as a
peer to `behaviours[]`, `frontend.*`, and `mcp.*` (`001 §1.1`).
Plugins that ship no commands omit the block entirely.

### 3.1 The `commands[]` block

```yaml
# plugin.yaml — fragment for the paid-baseline calendar plugin
name: example-calendar
version: 0.4.0
tier: pro
# … rest of the manifest as in `001 §1.1` …

commands:
  - name: calendar.add
    description: >
      Create a calendar event on the user's configured calendar.
      Accepts a free-form summary plus a start time and optional
      duration / location / recurrence.
    arguments_schema: ./schemas/calendar_add.args.schema.json
    result_schema:    ./schemas/calendar_add.result.schema.json
    handler: example_calendar.commands:add_event
    idempotent: true                       # default true; see §3.3
    mcp_tool: true                         # also expose via the plugin's MCP server, §8
    surfaces:
      ui:
        component: ./web/src/commands/CalendarAddForm.tsx
        confirm_label: "Add to calendar"
      telegram:
        # The free-text prompt the bot uses when /calendar is typed
        # without args. The adapter parses the user's next message
        # into CommandInput via a cheap classifier; see §5 (reserved).
        prompt: >
          What event, when, and (optionally) where?
          Examples:
            "tomorrow 14:00 dentist"
            "Fri 19:00 dinner at La Trattoria"
            "every Mon 09:30 standup for 30m"
        parser: classifier
      mcp:
        # Optional per-adapter overrides; usually empty since
        # mcp_tool: true plus the result_schema is enough.
        tool_name: calendar_add            # MCP tool slug if it should differ from `name`

  - name: calendar.list
    description: List upcoming events in a date range.
    arguments_schema: ./schemas/calendar_list.args.schema.json
    result_schema:    ./schemas/calendar_list.result.schema.json
    handler: example_calendar.commands:list_events
    idempotent: true
    mcp_tool: true
    surfaces:
      ui:
        component: ./web/src/commands/CalendarListForm.tsx
      telegram:
        prompt: "From when to when? e.g. 'today', 'this week', '2026-05-15..2026-05-20'"
        parser: regex                      # cheaper than classifier when grammar is tight
        regex_module: example_calendar.parsers:daterange
```

The peer plugin in the same bundle, `example-imap`, looks the
same shape with a different verb domain:

```yaml
# plugin.yaml — fragment for the paid-baseline imap plugin
name: example-imap
version: 0.3.2
tier: pro

commands:
  - name: email.send
    description: Send an email from the user's configured SMTP account.
    arguments_schema: ./schemas/email_send.args.schema.json
    result_schema:    ./schemas/email_send.result.schema.json
    handler: example_imap.commands:send_email
    idempotent: false                      # see §3.3 — sending is not retry-safe by default
    mcp_tool: true
    surfaces:
      ui:
        component: ./web/src/commands/EmailComposeForm.tsx
        confirm_label: "Send"
        confirm_destructive: true          # forces a second click in the UI
      telegram:
        prompt: >
          Three lines:
            to: someone@example.com
            subject: …
            body: …
        parser: regex
        regex_module: example_imap.parsers:email_three_lines
```

### 3.2 Field-by-field

| Field                 | Required | Shape                                                                                                                        |
|-----------------------|----------|-------------------------------------------------------------------------------------------------------------------------------|
| `name`                | yes      | Dot-separated slug `[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*`. First segment SHOULD match a domain owned by the plugin (`calendar.*` for the calendar plugin). Globally unique across the combined command + behaviour namespace (§3.4). Invoked by the user as `/<name>` on every text surface. |
| `description`         | yes      | One-paragraph plain-language summary. Rendered in `/`-autocomplete on every surface; consumed by the MCP-tool description when `mcp_tool: true`. Keep under ~280 chars. |
| `arguments_schema`    | yes      | Relative path to a JSON Schema file (per `004`) describing the validated input. Pydantic v2 model generated at activation. `additionalProperties: false` is required (§3.4). |
| `result_schema`       | yes      | Same shape as `arguments_schema`, describing the `CommandOutput.data` payload. May be `{"type": "null"}` for commands whose response is the `message` only. |
| `handler`             | yes      | `module:function` reference, same form as a behaviour handler (`001 §5.2`). Resolved at activation; failure to resolve is a fatal load error. |
| `idempotent`          | no       | Boolean, default `true`. See §3.3.                                                                                            |
| `mcp_tool`            | no       | Boolean, default `false`. When `true`, the command is auto-registered on the plugin's MCP server (`mcp.enabled: true` is required; MCP surface reserved in §5). |
| `surfaces`            | yes      | Map keyed by surface slug. At least one entry. See §3.5.                                                                      |

### 3.3 `idempotent`

The boolean answers one question: **is replaying this command
with the same `CommandInput` safe?**

- `idempotent: true` (default) — the handler is safe to call
  twice with the same input. The host short-circuits replays on
  `CommandContext.idempotency_key` (derived in §4.4). A
  Telegram bot that loses confirmation of a reply can resend the
  user's message; the handler runs once.
- `idempotent: false` — the handler is *not* retry-safe. The
  host's at-least-once delivery becomes effectively
  at-most-once: replays return the cached `CommandOutput` of the
  first attempt without re-invoking the handler. Failure during
  the first attempt surfaces to the user with a "retry was not
  attempted automatically" envelope; the user retries
  deliberately.

`email.send` is the canonical `idempotent: false` case: the
user typing `/email send` twice should send two emails, but the
Telegram-update redelivery of the *same* event must not. The
distinction is what `idempotency_key` covers — it includes the
surface event id (e.g. Telegram update id, HTTP request id), so
two genuine user invocations produce two keys.

Most commands should be `idempotent: true`. The default is
chosen accordingly. `idempotent: false` requires a deliberate
opt-out and is documented in the command's `description`.

### 3.4 Validation rules

Applied at plugin activation; failures are fatal load errors,
not warnings.

- **Name uniqueness, combined namespace.** A command `name` MUST
  NOT collide with any other command `name` *or* any behaviour
  `id` across all currently active plugins. The check extends
  the rule in `001 §1.2` on plugin-name uniqueness — the
  combined namespace prevents `/foo` being ambiguous between a
  command and an OFFER chip pointing at a behaviour also called
  `foo`.
- **Domain ownership.** The first dot-separated segment of
  `name` MUST match a domain the plugin owns. The default
  domain is the plugin's `name` with bundle-specific prefixes
  stripped; plugins may declare additional owned domains in a
  forthcoming `command_domains:` block (reserved in §5).
  This stops one plugin from squatting `calendar.*` if it is
  not the calendar plugin.
- **Schema files exist and are valid JSON Schema 2020-12.** Both
  `arguments_schema` and `result_schema` are codegen-checked at
  build time (`004 §3`); activation re-validates they resolve.
- **`arguments_schema` requires `additionalProperties: false`
  at the root.** A loose schema would let an adapter smuggle
  surface-specific fields into the handler, defeating §10's
  single-validation-pass invariant.
- **At least one `surfaces` entry.** A command with no surfaces
  cannot be invoked and is rejected. Note that `mcp_tool: true`
  alone is **not** a surface — it is an *additional* exposure
  on top of the declared adapters; an MCP-only command still
  declares `surfaces: { mcp: {} }` explicitly.
- **Surface slug is registered.** Every key in `surfaces` MUST
  match a slug present in the surface-adapter registry at
  activation time. A command declaring `surfaces.voice:` while
  no `voice` adapter is registered is a fatal load error — fail
  fast rather than silently dropping the surface.
- **No path escape.** `arguments_schema`, `result_schema`, and
  `surfaces.ui.component` paths MUST resolve inside the plugin
  root (same rule as `001 §1.2`).
- **Handler signature compatibility.** The handler's first
  parameter MUST type-hint the Pydantic model generated from
  `arguments_schema`; the second MUST type-hint
  `CommandContext`; the return MUST type-hint
  `CommandOutput[ResultModel]` where `ResultModel` is generated
  from `result_schema`. Mismatch is a fatal load error caught by
  a static check at build time and re-checked at activation.

### 3.5 The `surfaces` map

`surfaces:` is the open-ended extension point that lets new
surfaces ship without core changes. Two invariants pin it:

1. **Keyed by surface slug.** Each key is a short slug owned by
   the adapter that consumes it (`ui`, `telegram`, `mcp`,
   `voice`, `email`). At most one entry per slug per command —
   "the calendar plugin's `telegram` rendering of `calendar.add`"
   is exactly one value.
2. **Value shape is adapter-specific.** Core does not know the
   shape of `surfaces.ui.component`, `surfaces.telegram.prompt`,
   or `surfaces.mcp.tool_name`. Each adapter publishes a JSON
   Schema for its own value-shape under
   `packages/schemas/schemas/surfaces/<slug>.schema.json`; the
   host validates each `surfaces.<slug>` entry against the
   registered adapter's schema at activation. An adapter
   shipping without a schema is rejected.

The `ui` adapter (core; full UI integration reserved in §5) consumes:

```jsonc
// packages/schemas/schemas/surfaces/ui.schema.json (sketch)
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "component": { "type": "string" },          // plugin-root-relative
    "confirm_label": { "type": "string" },
    "confirm_destructive": { "type": "boolean", "default": false }
  },
  "required": ["component"]
}
```

The `telegram` adapter (paid baseline bundle; full Telegram-surface spec reserved in §5) consumes:

```jsonc
// packages/schemas/schemas/surfaces/telegram.schema.json (sketch)
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "prompt":        { "type": "string" },
    "parser":        { "enum": ["classifier", "regex", "none"] },
    "regex_module":  { "type": "string" }    // required if parser=regex
  },
  "required": ["prompt", "parser"]
}
```

The adapter's schema lives in the same `packages/schemas/`
tree as everything else; surface-shape changes follow the
same versioning policy as DTOs (`004 §9`).

### 3.6 Why a map, not a list

A list (`surfaces: [{slug: ui, …}, {slug: telegram, …}]`) was
considered and rejected. Reasons:

- A map makes "at most one entry per surface" a structural
  invariant the YAML parser enforces, rather than a validation
  check.
- Per-surface lookup at dispatch time is `O(1)` from the YAML
  shape without an indexing step.
- Authoring ergonomics: the `surfaces.ui:` block reads
  declaratively rather than as a list of named tuples. The
  cost is that surface slugs cannot collide with reserved YAML
  keywords; the registered-slug list is short and curated, so
  this is a non-issue.

### 3.7 Why not nest `commands[]` under `behaviours[]`

`001 §5` already has `behaviours[]`. Why a peer block rather than
a new behaviour kind (`trigger: command:nutrition`)?

- The dispatch shape differs (§2.2): commands skip the scope
  classifier, behaviours rely on it. Folding them into one
  registry means every behaviour-classifier filter has to know
  to exclude command-typed entries.
- The cost shape differs: a command turn has zero LLM calls on
  the happy path; a behaviour turn has at least one (the scope
  classifier). Mixing them into one block invites accidentally
  treating commands as "free behaviours" and routing through the
  classifier when not needed.
- The persistence shape differs (§2.2 again): `messages` rows
  carry different `event_type` values. Folding them muddies
  observability and dashboards.

The two are peers in the manifest because they are peers in the
runtime.

### 3.8 What this section adds to `001_PLUGINS.md`

Concretely, `001 §1.1` (manifest schema) needs the `commands:`
block added to its example, plus a forward-reference here. `001
§1.2` (validation rules) needs the combined-namespace check
added. Both edits are listed in §5 (reserved) for a single
follow-up patch when this doc reaches `Status: Pinned`.

---

## 4. Handler protocol

A command handler is a single async Python callable with a fixed,
surface-blind signature. The host owns dispatch, validation, and
persistence around the call; the handler owns the business logic
inside it. This split is the load-bearing anti-duplication rule
the issue motivating this doc (`#26`) calls out.

### 4.0 Note on core surfaces

Core ships **two** surface adapters, not one: `ui` (the Next.js
composer; `014 §4.5`) and `cli` (the agent REPL in `apps/cli/`;
see CLAUDE.md's top-level layout). The CLI is a first-class
command surface because the user types into a TTY exactly the
same way they type into the web composer — `/calendar add
tomorrow 14:00 dentist` works identically in both. The CLI
adapter's value-shape is published as
`packages/schemas/schemas/surfaces/cli.schema.json`; it is
intentionally minimal because the CLI's rendering is plain text.

All other surfaces (`telegram`, `mcp`, future `voice` / `email`)
ship as plugin-registered adapters in the paid baseline or
thematic bundles. The two-surface core baseline is what makes the
handler protocol meaningful — it can be exercised end-to-end
without any paid bundle installed.

### 4.1 The three types

A command's contract is fully described by three Pydantic v2
models. Two are generated from the manifest's schema files
(`004 §3`); one is shipped by core.

```python
# eidan/plugins/commands.py — core, ships in this repo

from typing import Generic, Literal, TypeVar, Any
from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, Field

# Generated per-command from arguments_schema; the concrete type
# the handler receives.
TIn = TypeVar("TIn", bound=BaseModel)

# Generated per-command from result_schema; the concrete type of
# CommandOutput.data.
TOut = TypeVar("TOut", bound=BaseModel)


class CommandContext(BaseModel):
    """
    Ambient invocation context handed to every command handler.
    Core constructs and validates this; adapters do not touch it.
    """
    model_config = {"frozen": True, "arbitrary_types_allowed": True}

    user_id: UUID
    conversation_id: UUID | None       # None for surfaces with no thread (e.g. one-shot CLI invocations, MCP)
    originating_surface: str           # registered surface slug: "ui" | "cli" | "telegram" | "mcp" | …
    surface_event_id: str | None       # surface-native event id, used in idempotency_key (§4.4)
    idempotency_key: str               # deterministic; see §4.4
    invoked_at: datetime               # set by core at dispatch time; not adapter-provided
    replayed: bool                     # True if this is a replay of a cached output (§4.4)

    # Capabilities the host injects. Concrete protocol types live
    # in `eidan/plugins/context.py`; sketched here for shape.
    vault: "VaultAccessor"             # ctx.vault.get("imap.password") → secret string
    db:    "PluginDBSession"           # scoped to this plugin's schema; cannot reach `eidan.*` directly
    logger: "Logger"                   # bound with command_name, surface, user_id, idempotency_key


class CommandOutput(BaseModel, Generic[TOut]):
    """
    The handler's return value. Adapters render this back to the
    user; core persists it to `messages` (§4.3) before any adapter
    sees it.
    """
    model_config = {"frozen": True}

    status: Literal["ok", "error"]
    message: str                       # plain-text human-readable; every surface can render it
    data: TOut | None = None           # typed payload, validated against result_schema
    error_class: str | None = None     # set iff status == "error"; an importable class name
    surface_hints: dict[str, Any] = Field(default_factory=dict)  # opt-in, opaque to core (§4.6)
```

`CommandInput` is *not* a named type in this module — each
command has its own concrete input model generated from its
`arguments_schema` (`004 §3`). Handlers type-hint the generated
class directly:

```python
# example_calendar/commands.py — example handler

from eidan.plugins.commands import CommandContext, CommandOutput
from example_calendar.schemas import (
    CalendarAddArgs,                    # generated from calendar_add.args.schema.json
    CalendarAddResult,                  # generated from calendar_add.result.schema.json
)

async def add_event(
    args: CalendarAddArgs,
    ctx: CommandContext,
) -> CommandOutput[CalendarAddResult]:
    ...
```

The signature is fixed: two positional arguments in this exact
order, `CommandOutput[ResultModel]` return. The static check
that enforces it runs at build time (`004 §3`) and is re-checked
at activation (§3.4).

### 4.2 The handler is async

All handlers are `async def`. The runtime is `asyncio`. Sync
handlers are rejected at activation with a clear error message
("wrap your sync work in `asyncio.to_thread`"); core does not
silently threadpool a sync function on the caller's behalf, both
because cancellation semantics differ and because tracing /
observability gets harder when sync work hides behind a fake
async signature.

A handler MUST:

- Complete within the per-command timeout (default **30s**;
  overridable via `timeout_seconds:` on the manifest entry,
  capped at 5 min). Exceeded timeouts raise
  `asyncio.CancelledError` inside the handler; the handler is
  expected to roll back partial work and propagate.
- Honour cancellation. Calling `await asyncio.sleep(…)` or any
  awaitable is enough; the host cancels the handler task when
  the surface event is withdrawn (e.g. WebSocket close, Telegram
  edit-then-delete, CLI Ctrl-C).
- Return a `CommandOutput`. Returning `None`, raising an
  exception, or returning a wrongly-typed object is a contract
  violation; core converts each of these into
  `CommandOutput(status="error", error_class=…)` with a logged
  warning — but plugin authors should not rely on the
  conversion, it exists only so the user-facing reply is never
  blank.

A handler MUST NOT:

- Talk to any surface directly (no Telegram bot calls, no
  WebSocket frames, no HTML responses, no `print()` to stdout).
  Surfaces consume the returned `CommandOutput`; the handler is
  surface-blind.
- Write `messages` rows. Core owns persistence (§4.3).
- Reach into another plugin's `plugin_<name>.*` schema, including
  via direct SQL through `ctx.db`. Cross-plugin operations go
  through the other plugin's MCP tools or commands.
- Mutate `CommandContext`. The model is frozen; mutation is a
  programming error.
- Cache state in process. Each invocation must be self-contained;
  the host may move a replay to a different process between
  attempts.

### 4.3 Eager persistence around the call

Two `messages` rows bracket every command invocation. The host
writes both; the handler never touches the table.

```
                ┌──────────────────────────────────────────────┐
adapter call    │                                              │
─────────────▶  │  core: validate input against args schema    │
                │  core: derive CommandContext + idempotency   │
                │        key                                    │
                │  core: write `command_invoked` row to        │
                │        messages (EP — `005 §1.1`)            │
                │  core: check idempotency cache; replay path  │
                │        short-circuits here                   │
                │                                              │
                │  ──── handler runs ────                       │
                │                                              │
                │  core: validate output against result schema │
                │  core: write `command_output` row to         │
                │        messages, FK-linked to invocation     │
                │  core: hand CommandOutput to the adapter for │
                │        rendering                              │
                └──────────────────────────────────────────────┘
                                       │
                                       ▼ adapter renders reply
```

Two new `messages.role` (or `messages.kind`, per the column name
settled in `003`) values land via additive migration when this
spec ships:

| New value           | Meaning                                                                                       |
|---------------------|-----------------------------------------------------------------------------------------------|
| `command_invoked`   | The user-attributable invocation row. Carries `metadata.command_name`, `metadata.surface`, `metadata.input_hash`, `metadata.idempotency_key`. Body is the raw surface-native input (e.g. the Telegram text, the form-encoded post body) for audit; the parsed `CommandInput` is in `metadata.input_validated`. |
| `command_output`    | The handler's reply. Carries `metadata.status`, `metadata.error_class`, `metadata.replayed`. Body is `CommandOutput.message`; the typed `data` payload is in `metadata.output_data`. `parent_message_id` references the `command_invoked` row.                                                              |

Both rows are part of the same conversation when one exists
(adapters that lack a `conversation_id` — one-shot CLI runs,
some MCP clients — open an implicit ephemeral conversation
keyed on `(user_id, surface, surface_event_id)`; this is the
same mechanism `005 §5.1` uses for missing-conversation
inbound).

The invocation row is committed **before** the handler runs.
This is the keen-save invariant from `005 §1.1` applied to
commands: if the handler crashes mid-execution or the process
dies, the conversation log accurately reflects that the
command was attempted, and replay logic (§4.4) can resume from
the row.

### 4.4 Idempotency mechanics

The `idempotency_key` in `CommandContext` is deterministic:

```
idempotency_key = sha256(
    user_id || "\0" ||
    command_name || "\0" ||
    canonical_json(CommandInput) || "\0" ||
    originating_surface || "\0" ||
    surface_event_id || ""
)
```

Two parts deserve a comment:

- **`canonical_json(CommandInput)`** uses sorted keys and the
  Pydantic-defined serialisation, so structurally equivalent
  inputs hash identically regardless of which adapter produced
  them. A `/calendar add` typed in the UI and the same
  invocation pasted into the CLI yield different keys (different
  `originating_surface`); a duplicated Telegram update
  redelivery yields the same key.
- **`surface_event_id`** is the adapter's responsibility to fill
  honestly. The Telegram adapter passes `update.update_id`; the
  UI adapter passes the HTTP `X-Request-Id`; the CLI passes a
  per-keystroke nonce; MCP passes the JSON-RPC request id. The
  empty-string fallback is for adapters with no useful id —
  those commands behave as fully idempotent on
  `(user_id, command_name, input)`.

The cache table `eidan.command_idempotency` stores
`(idempotency_key, CommandOutput_blob, expires_at)`. Lookup is
the first thing core does after writing the `command_invoked`
row. Cache hits:

- **`idempotent: true`** (default) — return the cached
  `CommandOutput` directly, mark `ctx.replayed = true` in a
  fresh row, do not call the handler. Old `messages` rows are
  untouched.
- **`idempotent: false`** — same behaviour. The
  `idempotent` flag does **not** mean "rerun on replay"; it
  means "treat the original call as the authoritative attempt
  and never re-execute". The cached output is returned with
  `replayed=true` so the adapter can render an "already done"
  hint if it chooses (a Telegram adapter might use a slightly
  different reply for replays; the UI typically does not need
  to).

Cache TTL defaults to 24h, overridable per command via
`idempotency_ttl_seconds:` on the manifest entry. The cache is
swept by a background job; expired rows do not block re-execution.

### 4.5 Errors

Three error paths, each handled the same way: a
`CommandOutput(status="error", …)` row is persisted and returned
to the adapter. The handler never raises out of the host's call
site.

| Error path                              | `error_class`                | `message` example                                                       |
|-----------------------------------------|------------------------------|-------------------------------------------------------------------------|
| `CommandInput` validation fails         | `ValidationError`            | "field 'when' must be an ISO 8601 timestamp"                            |
| Handler raises an arbitrary exception   | the exception's class name   | the exception's `str()` if non-empty, else a generic message            |
| Handler timeout                         | `asyncio.TimeoutError`       | "command timed out after 30s; partial work was rolled back if possible" |
| Handler returns a wrong type            | `OutputContractError`        | "handler returned T, expected CommandOutput[ResultModel]"               |
| Surface not registered (§3.4)           | `SurfaceNotRegisteredError`  | "this command is not available on '<surface>'"                          |

Adapters render `message` plus any `surface_hints` they
recognise. Adapters MUST NOT inspect `error_class` to choose
behaviour — that field is for observability and tests, not for
branching UX. If a command needs surface-specific error rendering
the handler attaches `surface_hints["render"] = "danger_box"`
(or similar) and lets the adapter pattern-match on the hint.

### 4.6 `surface_hints`

A small escape hatch for *non-essential* adapter customisation.
Core does not validate or interpret these — each adapter
declares which keys it consumes in its own published schema
(`packages/schemas/schemas/surfaces/<slug>.schema.json`).
Examples:

- `ui` consumes `{"layout": "table" | "card"}` for richer
  rendering of structured `data`.
- `telegram` consumes `{"markdown": true}` to switch its reply
  parse mode to `MarkdownV2`.
- `cli` consumes `{"colour": true | false}` to override the
  terminal's auto-detected colour support.

The contract: a handler that adds a hint an adapter does not
understand is a no-op, not an error. This keeps `surface_hints`
forward-compatible — handlers can suggest improvements that
older adapters silently ignore.

### 4.7 The two canonical handlers wired up

```python
# example_calendar/commands.py
async def add_event(
    args: CalendarAddArgs,
    ctx: CommandContext,
) -> CommandOutput[CalendarAddResult]:
    # 1. Per-user creds. Vault declared in plugin.yaml (`001 §1.1`).
    caldav_url = await ctx.vault.get("calendar.caldav_url")
    caldav_pw  = await ctx.vault.get("calendar.caldav_password")

    # 2. Pure business logic. No surface knowledge anywhere.
    try:
        event = await caldav_create(
            url=caldav_url, password=caldav_pw,
            summary=args.summary,
            starts_at=args.starts_at,
            duration=args.duration,
            location=args.location,
        )
    except CalDAVConflict as exc:
        return CommandOutput(
            status="error",
            error_class="CalDAVConflict",
            message=f"That slot conflicts with: {exc.existing.summary}",
            surface_hints={"layout": "card"},      # ui shows it as a card
        )

    # 3. Plugin-private persistence in plugin_calendar schema.
    await ctx.db.execute(
        "INSERT INTO events (caldav_uid, user_id, …) VALUES (…)",
        ...
    )

    # 4. Typed result. The same payload reaches every adapter.
    return CommandOutput(
        status="ok",
        message=f"Added: {event.summary} at {event.starts_at:%a %d %b %H:%M}",
        data=CalendarAddResult(
            event_id=event.caldav_uid,
            starts_at=event.starts_at,
            ends_at=event.ends_at,
        ),
    )
```

```python
# example_imap/commands.py
async def send_email(
    args: EmailSendArgs,
    ctx: CommandContext,
) -> CommandOutput[EmailSendResult]:
    # idempotent: false on the manifest entry (§3.1). The host
    # does not replay this handler on a cached idempotency_key
    # match; it returns the cached output instead. The handler
    # itself does not need to defend against replays.
    smtp_creds = await ctx.vault.get_smtp_creds(ctx.user_id)

    try:
        message_id = await smtp_send(
            host=smtp_creds.host, port=smtp_creds.port,
            username=smtp_creds.username, password=smtp_creds.password,
            to=args.to, subject=args.subject, body=args.body,
        )
    except SMTPAuthError as exc:
        return CommandOutput(
            status="error",
            error_class="SMTPAuthError",
            message="Mailbox credentials were rejected. Re-link in Settings → Email.",
        )

    return CommandOutput(
        status="ok",
        message=f"Sent to {args.to}",
        data=EmailSendResult(message_id=message_id, sent_at=ctx.invoked_at),
    )
```

Both handlers are entirely surface-blind. The UI form, the
Telegram one-liner parser, the CLI prompt, and the MCP tool all
funnel into the same callable; the only thing the handler ever
learns about the surface is `ctx.originating_surface`, and even
that is for telemetry, not branching.

### 4.8 Why this protocol shape

The chosen shape — two generated input/output models, one
core-shipped `CommandContext`, async-only, all error paths fold
into `CommandOutput(status="error", …)` — solves three problems
the predecessor stack had:

1. **No place for surface logic to leak into the handler.**
   `ctx` exposes capabilities (vault, db, logger), not adapter
   primitives. There is no `ctx.reply()`, no `ctx.set_typing()`,
   no `ctx.attach_image()`. If a handler needs to influence
   rendering, it does it through the typed `data` payload or the
   open-ended `surface_hints` map.
2. **No place for validation drift.** `CommandInput` is the only
   way the handler receives args; adapters cannot wrap or bypass
   the Pydantic instance. The single-validation-pass invariant
   (reserved in §5) follows mechanically.
3. **No place for partial persistence.** The `messages`-row
   bracket is unconditional; even crashing handlers leave a
   complete invocation record.

The cost is a small amount of ceremony for trivial commands.
That is the right trade: trivial commands are cheap to write
*anyway*, and the floor for non-trivial commands is what
matters.

---

## 5. Reserved for follow-ups

§1–§4 pin the vocabulary, the commands-vs-behaviours boundary,
the manifest surface, and the handler protocol — enough to start
shipping plugin commands against a stable contract. The remaining
machinery is deferred to a follow-up revision rather than rushed
into this commit. The list below is the single source of "what is
not yet specified"; inline pointers earlier in the doc all refer
back here.

- **Surface-adapter protocol.** The `Adapter` interface, how
  `ui` / `cli` / `telegram` / `mcp` slot in, the surface-adapter
  registry shape, lifecycle hooks.
- **UI surface.** Un-defer the `command-palette.action` slot from
  `014_UI_SURFACE.md §10`; composer parsing of `/<name>`; form
  rendering from `arguments_schema`.
- **Telegram surface (informative).** Sequence diagram, pointer
  to the paid-baseline Telegram adapter, what core does *not*
  know about the wire protocol.
- **MCP surface.** `mcp_tool: true` semantics, schema reuse,
  how the inbound MCP server registers commands as tools
  alongside `mcp.tools[]` from `001 §7`.
- **Registration mechanism.** Registry build at activation,
  collision policy across the combined command + behaviour
  namespace, per-turn snapshot so reinstalls mid-turn do not
  change dispatch.
- **Validation invariants.** Single-pass at the core boundary,
  no adapter bypass, how the Pydantic-generated `CommandInput`
  is the only path to handler args.
- **Observability.** `messages` row shape for `command_invoked`
  and `command_output`, `command_name` / `surface` / `input_hash`
  metadata, how dashboards roll up command-vs-behaviour split.
- **Conflict and surface-fallback.** Command invoked on a surface
  with no adapter, structured "not supported" envelope, the UX
  for `/foo` on a surface that does not register `foo`.
- **`command_domains:` manifest block.** The opt-in mechanism a
  plugin uses to declare additional owned name prefixes beyond
  the default derived from its plugin name (§3.4).
- **End-to-end example.** `/calendar add` and `/email send` worked
  all the way through manifest → handler → three adapters → DB
  rows, with the exact persisted `messages` shape.
- **Cross-spec patches.** The small edits to `001` (manifest
  example + combined-namespace validation), `006` (cross-link
  command/behaviour interaction in §2.3), `013` (MCP-tool source
  table), and `014` (`command-palette.action` un-deferral) that
  land alongside this doc reaching `Status: Pinned`.

---

**Maintained by:** Sielay Ltd
**Last updated:** 2026-05-22
