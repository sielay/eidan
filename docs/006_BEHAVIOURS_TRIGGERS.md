# 006 — Behaviours and triggers

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Agentic loop, Plugins),
`docs/001_PLUGINS.md` (§2 PluginContext, §5 Behaviours and triggers),
`docs/003_MEMORY_DDL.md` (§7 `agent_context`, §9 `llm_calls`),
`docs/004_SCHEMAS.md` (`agentic/*` DTOs),
`docs/005_AGENTIC_LOOP.md` (§5.4 Behaviours and tool surface)

This document specifies the **loadable-directive subsystem** the
agentic loop activates just-in-time. It fills in the gap left open
by `005_AGENTIC_LOOP.md §5.4` ("the runner builds two artefacts…")
by defining:

- What a behaviour *is* in Python (data shape, registration, lifecycle).
- What a trigger *is* (the natural-language description and the
  numeric index the classifier uses to refer to it).
- How a small classifier LLM call picks which behaviours fire for a
  given user message.
- How a loaded behaviour mutates the primary call's system prompt
  and tool surface.
- The AUTO vs OFFER activation modes and how each propagates
  through the loop.
- Conflict resolution when more than one behaviour matches.

The trigger grammar in `001_PLUGINS.md §5.1` (`event:`, `cron:`,
`webhook:`, `schedule:`, `agent:`) is unchanged by this document.
This spec adds a sixth kind, `intent:`, that the **behaviour
classifier** matches against a user message. The other five remain
the responsibility of the bus / scheduler / webhook router.

Out of scope (deferred to follow-ups, see §11):

- The wire format of the classifier's input and output — owned by
  `004_SCHEMAS.md` once the schema is stable.
- The exact prompt the OFFER mode shows in the UI — owned by the
  frontend spec.
- Per-user telemetry and ranking that *learns* which behaviours
  fire well for a given user.

---

## 1. Vocabulary

| Term                    | Meaning                                                                                                 |
|-------------------------|----------------------------------------------------------------------------------------------------------|
| **Behaviour**           | A registered Python handler plus its declarative metadata (triggers, mode, prompt stanza, tools, …).     |
| **Trigger**             | One activation entry-point attached to a behaviour. A behaviour may carry several triggers.              |
| **`intent:` trigger**   | A natural-language description matched by the behaviour classifier (this document's new trigger kind).   |
| **Classifier**          | A cheap LLM call that takes the user message + a numbered list of `intent:` triggers and returns matches.|
| **AUTO behaviour**      | Loaded into the primary call as a system-prompt stanza and tool. The model decides if and how to invoke. |
| **OFFER behaviour**     | Surfaced to the user as a chip / affordance; the behaviour body only runs after explicit confirmation.   |
| **Numeric trigger index** | A stable, per-turn integer the classifier returns. It identifies a trigger without repeating its text. |
| **Behaviour registry**  | The in-process table the host populates from each plugin's manifest at activation time (§4).             |

The classifier is a new LLM role. It maps onto a new value of
`eidan.llm_calls.role` — `behaviour_classifier` — added as an
additive migration to the `llm_calls_role_chk` constraint defined
in `003_MEMORY_DDL.md §9`, alongside the other new roles listed in
`005_AGENTIC_LOOP.md §7`.

---

## 2. Behaviour data shape

A behaviour is **declarative metadata plus a callable**. We model
the metadata as a frozen `dataclass` and the callable as a function
that conforms to a fixed protocol. There is no decorator and no
class hierarchy — both were considered and rejected (§2.4).

### 2.1 The `Behaviour` dataclass

```python
# eidan/plugins/behaviours.py
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable, Sequence

from eidan.plugins import PluginContext


class ActivationMode(str, Enum):
    AUTO  = "auto"   # injected into the primary call; model decides
    OFFER = "offer"  # surfaced to the user; runs on explicit confirm


@dataclass(frozen=True, slots=True)
class Trigger:
    """One activation entry-point attached to a behaviour.

    Mirrors the grammar in 001_PLUGINS.md §5.1 plus the new
    `intent:` kind specified in this document.
    """
    kind: str            # one of: "intent" | "event" | "cron"
                         # | "webhook" | "schedule" | "agent"
    spec: str            # for intent: the natural-language description
                         # for event: the event name; etc.


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """A tool the behaviour contributes to the primary's tool surface.

    The schema is the JSON Schema authored under `packages/schemas/`
    that already drives Pydantic + Zod codegen (004_SCHEMAS.md §8.1).
    No second copy is hand-written here.
    """
    name: str                          # externally visible tool name
    description: str                   # the model sees this verbatim
    input_schema_id: str               # the `$id` of the input schema
    tags: frozenset[str] = frozenset() # e.g. {"may_egress_user_data"}


HandlerFn = Callable[
    [PluginContext, "BehaviourInvocation"],
    Awaitable["BehaviourResult"],
]


@dataclass(frozen=True, slots=True)
class Behaviour:
    """The full record for a registered behaviour.

    Constructed from the plugin manifest at activation time (§4)
    and stored in the in-process registry until deactivation.
    """
    id: str                       # globally unique, plugin-prefixed
                                  # e.g. "example-notes:summarise_daily"
    plugin: str                   # owning plugin slug
    triggers: Sequence[Trigger]
    mode: ActivationMode
    prompt_stanza: str            # contributed to the system prompt
                                  # when this behaviour is loaded
    tools: Sequence[ToolSpec] = ()
    priority: int = 100           # lower wins on conflict (§8)
    handler: HandlerFn = field(repr=False)
```

The `id` is the canonical identifier the runner, the database, and
logs use to refer to a behaviour. It is **not** the same as the
classifier's numeric trigger index — the numeric index is
short-lived (rebuilt per classifier call, §5.2) and exists only to
keep the classifier's input small.

### 2.2 Handler protocol

The handler is a plain async function. We give the host two
companion dataclasses so the surface is typed end to end:

```python
@dataclass(frozen=True, slots=True)
class BehaviourInvocation:
    """What the host passes to a handler when it fires."""
    behaviour_id: str
    trigger: Trigger
    mode: ActivationMode
    user_message_id: str         # the turn anchor (005 §5.1)
    conversation_id: str
    agent_id: str
    classifier_reason: str | None # filled when fired via classifier
    payload: dict | None         # for non-intent triggers


@dataclass(frozen=True, slots=True)
class BehaviourResult:
    """What the handler returns.

    For AUTO behaviours the result is consumed inside the primary
    loop (its `prompt_stanza` is already in the prompt; the handler
    body, if it ran, may have produced extra `notes_for_model` that
    are appended as a tool turn). For OFFER behaviours the result
    is what the user actually triggered: a short summary plus any
    follow-up events.
    """
    ok: bool
    notes_for_model: str | None = None  # injected as a tool message
    follow_up_events: Sequence[dict] = ()  # published on ctx.bus
    error: str | None = None
```

### 2.3 Registration site

Plugins register behaviours from `on_activate(ctx)` (the lifecycle
hook in `001_PLUGINS.md §2.2`). The registration call is
synchronous: the host populates the registry before
`on_activate` returns. A plugin that registers a behaviour with
an `id` that collides with one already in the registry fails to
activate with `BehaviourIdConflict`, mirroring the route-collision
rule in `001_PLUGINS.md §3.3`.

```python
# example_notes/plugin.py
from eidan.plugins import PluginBase, PluginContext
from eidan.plugins.behaviours import (
    Behaviour, Trigger, ToolSpec, ActivationMode,
)

from .behaviours import summarise_daily_handler


class Plugin(PluginBase):
    name = "example-notes"

    async def on_activate(self, ctx: PluginContext) -> None:
        ctx.register_behaviours([
            Behaviour(
                id="example-notes:summarise_daily",
                plugin="example-notes",
                triggers=[
                    Trigger(
                        kind="intent",
                        spec="user asks for a summary of today's notes",
                    ),
                    Trigger(kind="cron", spec="0 7 * * *"),
                ],
                mode=ActivationMode.OFFER,
                prompt_stanza=(
                    "If the user asks about today's notes you may call "
                    "the `notes.summarise_daily` tool. Prefer it to "
                    "answering from memory."
                ),
                tools=[
                    ToolSpec(
                        name="notes.summarise_daily",
                        description="Summarise the user's notes for today.",
                        input_schema_id=(
                            "https://schemas.eidan.dev/plugins/"
                            "example-notes/SummariseDailyInput/v1.json"
                        ),
                    ),
                ],
                handler=summarise_daily_handler,
            ),
        ])
```

Note that a single behaviour can carry several triggers of
different kinds. The `intent:` trigger above is what the
classifier matches; the `cron:` trigger fires the same handler at
07:00 daily without any user message in the loop (the
background-only path is `005_AGENTIC_LOOP.md §10`'s reserved spec).

#### Relationship to `plugin.yaml`

`001_PLUGINS.md §5` declares behaviours in the manifest under
`behaviours[]` (id, triggers, handler reference). That manifest
entry remains the discoverable, lint-able source of metadata —
the host parses it at install time to know what the plugin
contributes without executing Python. The `Behaviour` dataclass
constructed in `on_activate` is the **runtime** view of the same
record, with two pieces the manifest cannot carry: the resolved
handler callable and the in-process `ToolSpec`s.

The host treats the manifest as the contract and the dataclass
as the realisation. At activation, if the dataclass set
`ctx.register_behaviours` receives does not cover every `id`
listed in `behaviours[]` (or vice versa) the plugin fails to
activate with `BehaviourManifestMismatch`. This keeps the
manifest honest without forcing the runtime to consume YAML.

### 2.4 Why dataclass, not decorator or class

We considered three shapes for the registration surface:

| Shape                       | Why not chosen                                                                                          |
|-----------------------------|----------------------------------------------------------------------------------------------------------|
| `@behaviour(...)` decorator | Hides metadata away from the manifest. Plugins already declare behaviours in `plugin.yaml` (001 §5);     |
|                             | the runtime shape should be the same data, not a second source of truth. Decorators also encourage      |
|                             | scattering registrations across files, which makes the `on_activate` discovery story messy.             |
| `class Behaviour(...)` base | Forces inheritance for what is fundamentally data. The handler being a plain function plus a dataclass  |
|                             | composes better with testing — a handler can be called directly with a fake `BehaviourInvocation`       |
|                             | without instantiating a class hierarchy.                                                                |
| `dataclass(frozen=True)`    | **Chosen.** Immutable, hashable by id, trivial to serialise for diagnostics, no inheritance trap.       |

The decorator form is left available as a thin convenience built
on top of the dataclass — `@behaviour(...)` produces a `Behaviour`
instance and stashes it on a module-level list — but the registry
contract is dataclass-shaped. Code that registers without the
decorator is the canonical path.

---

## 3. Trigger data shape

This section narrows in on the `intent:` trigger kind, since the
other kinds are already specified in `001_PLUGINS.md §5.1`.

### 3.1 The natural-language description

`Trigger.spec` for an `intent:` trigger is a **single English
sentence** describing the situation in which this behaviour
should fire. Style guide:

- One observable condition per trigger, phrased in third person
  about the user. *"user asks for a summary of today's notes"* is
  good; *"summarise notes"* (verbless, ambiguous subject) is bad.
- Avoid implementation jargon — the classifier sees the
  description, not the code. *"call summarise_daily_handler"* is
  wrong; the classifier does not know what that handler is.
- Avoid negation. *"user does NOT mention …"* asks the classifier
  to do logical inversion, which small models do poorly.
- 6–20 words is the comfortable band. Triggers shorter than that
  collide with each other; longer ones inflate classifier cost.

A behaviour MAY carry multiple `intent:` triggers when it fires
for genuinely distinct situations:

```python
triggers=[
    Trigger(kind="intent",
            spec="user asks for a summary of today's notes"),
    Trigger(kind="intent",
            spec="user says good morning and has unread notes"),
]
```

Two triggers attached to the same behaviour are independent
from the classifier's point of view — either can fire it.

### 3.2 The numeric index

The classifier sees triggers as a numbered list. The number is
**assigned by the runner per turn**, not by the plugin author.
Doing it this way keeps the index dense (1..N over the triggers
that survived filtering, §5.1) and avoids the classifier seeing
gaps that the user has disabled some behaviours.

```
1. user asks for a summary of today's notes
2. user says good morning and has unread notes
3. user wants to schedule a reminder
…
```

The runner keeps a per-turn map `index_to_trigger: dict[int,
TriggerRef]` where `TriggerRef = (behaviour_id, trigger_position)`.
The classifier output is parsed back to behaviours via this map.
The map is **not** persisted — it lives in the in-memory
`TurnContext` and is rebuilt each turn.

### 3.3 What goes into the description vs. the prompt stanza

These two free-text fields belong to different audiences:

- `Trigger.spec` is read by the **classifier**, alongside dozens
  of peers. It answers "should this fire for this user message?"
  and nothing else. It does not describe what the behaviour
  *does*; it describes when it *applies*.
- `Behaviour.prompt_stanza` is read by the **primary call**, only
  when the behaviour was selected. It answers "now that you are
  loaded, what should the model know about you?" — typically a
  policy or a hint about a tool's preferred use.

Mixing them muddies both. A trigger description that doubles as
guidance for the primary inflates classifier cost without
helping the classification decision; a prompt stanza that doubles
as a classifier hint pollutes the primary's prompt with
classifier-shaped reasoning that doesn't serve the model's
substantive task.

---

## 4. Registration mechanism

### 4.1 Lifecycle hook

Behaviours flow into the registry via `ctx.register_behaviours`
in the plugin's `on_activate` (`001_PLUGINS.md §2.2`):

```
host start
   │
   ▼
foreach plugin in topo order:
   │
   ▼
   on_activate(ctx)
      │
      ▼
      ctx.register_behaviours([Behaviour(...), ...])
         │
         ▼
         BehaviourRegistry.register(plugin=<slug>, behaviours=[...])
```

`ctx.register_behaviours` is idempotent within a single
activation: registering the same `id` twice raises
`BehaviourIdConflict`. Across host restarts the registry is
rebuilt from scratch — there is no persistent registry table,
because the source of truth is the plugin code itself.

### 4.2 The in-process registry

```python
# eidan/plugins/registry.py

class BehaviourRegistry:
    """In-process catalogue. One per host process.

    Read-mostly: writes happen at activation, reads happen on
    every turn (§5). Implementation is a frozenset-of-Behaviour
    per (plugin, agent_id) tuple, indexed by `id` for direct lookup.
    """

    def register(self, plugin: str, behaviours: list[Behaviour]) -> None: ...

    def unregister(self, plugin: str) -> None: ...

    def for_agent(
        self,
        agent_id: str,
        scope: ScopeResult,
    ) -> Sequence[Behaviour]:
        """Return behaviours eligible to be classified for this turn.

        Filtered by:
          - `agent_context.enabled` (`003_MEMORY_DDL.md §7`)
          - scope-based tag rules (e.g. write tools excluded when
            scope.intent = 'chitchat')
          - the agent's per-user override `behaviours.disabled[]`
            from `agent_context.user_overrides`
        """

    def by_id(self, behaviour_id: str) -> Behaviour: ...
```

`for_agent` is what step ⑤ of the turn (`005 §5.4`) calls before
the behaviour-classifier step (§5 below).

### 4.3 Deactivation

When a plugin deactivates (`001_PLUGINS.md §8.3`) the registry's
`unregister(plugin)` drops the rows owned by that plugin. A turn
already in flight keeps a stable view of the registry it picked
up at the start of the turn — see the snapshot rule in §4.4.

### 4.4 Snapshot per turn

The runner reads the registry **once** at step ⑤ and threads the
resulting tuple through the rest of the turn. This means a hot
reload of a plugin mid-turn does not change the behaviour set
under the active turn's feet; the next turn picks up the new
registry contents. The snapshot is a `frozenset[Behaviour]`
referenced by `TurnContext.behaviours_snapshot`.

---

## 5. Classifier prompt construction

The behaviour classifier is a new step inserted between
`005_AGENTIC_LOOP.md` step ⑤ (load behaviours) and step ⑥
(primary call). It is **a small LLM call**, in the same cost
class as the scope classifier (`005 §5.2`) and the sizer
(`005 §5.3`).

The reason this is an LLM call and not a deterministic match: the
trigger description is natural language and the user's intent is
natural language. A keyword-matching rule that worked for half
the descriptions would be the wrong shape — the moment the
descriptions get nuanced (negation, prerequisites, multi-step
intents), the rule path dies and we need a model anyway. Putting
the LLM here from day one keeps one path.

### 5.1 Filtering before the classifier sees anything

Before building the classifier prompt the runner narrows the
candidate set:

1. Start with `registry.for_agent(agent_id, scope)`.
2. Drop any behaviour whose **only** triggers are non-`intent:`.
3. Drop any behaviour the user has disabled
   (`agent_context.user_overrides.behaviours.disabled[]`).
4. Drop any behaviour tagged in a way scope precludes — e.g.
   `tool.may_egress_user_data` when `scope.sensitivity = high`
   (the same filter `005 §5.4` applies to the tool surface).
5. Cap the survivors at **N = 32** by `priority` (lower first).
   Above N is a warning, not an error: the runner logs the
   omitted behaviours so the operator notices.

The cap is identical in shape to the tool-surface cap in
`005 §5.4` because the same context-budget problem applies — the
classifier prompt also costs tokens.

### 5.2 Prompt assembly

```text
SYSTEM:
  You are a routing classifier. The user just sent the message
  below. You will see a numbered list of situations. Return the
  numbers of the situations that match. Return [] if none match.
  Do not invent numbers.

USER MESSAGE:
  <verbatim user_msg.content, truncated to 2 KB>

SITUATIONS:
  1. <Trigger.spec of survivor #1>
  2. <Trigger.spec of survivor #2>
  3. <Trigger.spec of survivor #3>
  …

RECENT CONTEXT (oldest → newest, content only):
  - <last ~4 messages>

RESPOND WITH JSON:
  { "matches": [<int>, …], "reason": "<one short sentence>" }
```

Notes on each section:

- **SITUATIONS** is the flattened list of every `intent:` trigger
  attached to every surviving behaviour. A behaviour with two
  `intent:` triggers occupies two lines. The index → `(behaviour,
  trigger_position)` map is built here.
- **RECENT CONTEXT** is the same lean window the scope classifier
  uses (`005 §5.2`). We deliberately keep it short — the
  classifier is not the place for long-range reasoning.
- The output is JSON for the same reason the scope classifier's
  is JSON: deterministic parsing, no prose to strip.

### 5.3 Output

```ts
// agentic/BehaviourMatchResult.schema.json
type BehaviourMatchResult = {
  matches: number[];   // numeric trigger indices, classifier's input list
  reason: string;
};
```

The runner parses the integers through the per-turn map (§3.2),
dedupes to behaviours (multiple triggers on the same behaviour
collapse to one match), and produces the **per-turn loaded set**.

If the classifier returns an index outside `[1..N]` the runner
logs and discards that entry; it does not fail the turn. A
classifier that returns `[]` is the common case — most turns load
no behaviours and the primary runs against the agent's defaults
only.

### 5.4 Cost rollup

The classifier emits one `llm_calls` row with `role =
'behaviour_classifier'`, `message_id = user_msg.id`, the standard
token / cost / latency fields, and `metadata.candidates = N`
(survivors after filtering). This is one extra row per turn —
small, predictable, and rolls up into the per-turn cost query in
`005 §9` unchanged.

### 5.5 Retry / timeout policy

| Step                  | Retries | Per-call timeout | Per-step deadline | On exhaustion                                                  |
|-----------------------|---------|------------------|-------------------|-----------------------------------------------------------------|
| Behaviour classifier  | 1       | 5 s              | 15 s              | proceed with `matches = []` (no behaviours load this turn)      |

Same shape as the scope classifier and sizer in `005 §6.4`. The
turn never fails because the classifier fell over — it just runs
without behaviour augmentation.

---

## 6. How a loaded behaviour mutates the primary call

Two side effects when a behaviour is loaded for a turn, both
applied at step ⑤ of `005_AGENTIC_LOOP.md` after the classifier
result is in hand.

### 6.1 System-prompt assembly

The runner concatenates the loaded behaviours' `prompt_stanza`
fields into a dedicated section of the system prompt, ordered
by `priority` ascending then `id` lexicographic for ties:

```
[ agent identity, code_defaults.system_prompt + user_overrides ]
[ user facts: identity, goals ]
[ scope hint: <one line> ]
[ behaviours active this turn ]
  - behaviour <id>:
      <prompt_stanza>
  - behaviour <id>:
      <prompt_stanza>
[ end behaviours ]
```

The section markers (`[ behaviours active this turn ]` / `[ end
behaviours ]`) are present even when no behaviour loaded — the
section is just empty. The marker is there so the primary's
prompt is shape-stable across turns; that stability matters for
prompt-cache hit rate on the provider side.

### 6.2 Tool surface

Each loaded behaviour's `ToolSpec` entries are concatenated into
the tool surface assembled in `005 §5.4`. The same N=32 surface
cap applies. The same `scope.sensitivity = high` exclusion for
`may_egress_user_data`-tagged tools applies.

A behaviour with no `tools[]` contributes only its
`prompt_stanza` — that is a legitimate, common shape: a behaviour
that exists just to tell the model "be brief today" or "the user
is on mobile" doesn't need a tool.

A behaviour with `tools[]` but an empty `prompt_stanza` is also
legitimate: a pure capability addition. We don't enforce that one
or the other must be present — the behaviour author decides.

### 6.3 What is NOT mutated

- The model class chosen by the sizer (`005 §5.3`). A behaviour
  that needs the large class advertises it via a tag the sizer
  reads (`tool.requires_deep_reasoning`); it does not pick the
  model itself.
- The scope decision (`005 §5.2`). The classifier runs *after*
  scope and accepts scope as a filter. A behaviour cannot override
  a `scope.action = deny`.
- The persistence rules (`005 §1.1`). EP is the runner's
  invariant; behaviours don't touch it.

This is the boundary that makes the subsystem composable: a
behaviour is a participant in a turn, not a redefinition of one.

---

## 7. AUTO vs OFFER modes

The two modes are the same up to the moment the classifier
matches. After that they diverge.

### 7.1 AUTO

```
classifier matches behaviour B (mode=AUTO)
   │
   ▼
behaviour B's prompt_stanza injected into system prompt (§6.1)
behaviour B's tools[]      injected into tool surface  (§6.2)
   │
   ▼
primary call runs with B's prompt + tools available
   │
   ▼
model decides whether to call B's tool(s) (it may or may not)
   │
   ▼
if it does: handler runs inside the primary loop as a tool turn
            (the existing `005 §5.5` flow, unmodified)
```

The handler in AUTO mode is invoked **only if the model decides
to call its tool**. The handler is not pre-invoked at step ⑤. The
runner does not "warm up" AUTO behaviours by running their
handlers before the primary — the contract is that the primary
chooses, like with any other tool.

This means an AUTO behaviour with no tools is **purely a
prompt-injection mechanism**: its `prompt_stanza` is loaded and
that is all that happens. The handler is unreachable in that
shape, which is allowed (and is the shape "be brief today"
behaviours take). The host warns at registration time when an
AUTO behaviour has no tools and a non-empty handler, since the
handler will never fire.

### 7.2 OFFER

```
classifier matches behaviour B (mode=OFFER)
   │
   ▼
synthesis emits an "offer chip" to the UI alongside the response
   │
   ▼
user clicks/confirms                  user ignores
   │                                   │
   ▼                                   ▼
new turn submitted, metadata          chip disappears at next
points at the offer; the runner       turn; no handler runs
fires B's handler with the OFFER
invocation; result is rendered as
a follow-up assistant message
```

The OFFER path uses the existing turn pipeline for confirmation —
the user's click is *literally* a follow-up user message with a
small metadata flag (`metadata.confirms_offer = <behaviour_id>`).
The runner intercepts that flag at step ② and runs the handler
directly instead of going through scope/sizer/primary. The
handler's `BehaviourResult` is wrapped in an assistant message
and that is what the user sees.

This is deliberate: confirmation of an offer should not consume a
fresh round of primary tokens. The user already saw the model's
substantive response in the previous turn; the offer body is a
follow-up artefact, not a new conversation.

### 7.3 Choosing between AUTO and OFFER

A rough rule for behaviour authors:

| Use AUTO when…                                                                                          | Use OFFER when…                                                                                       |
|----------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| The behaviour is a capability the model *might want to use* if it's relevant to the answer.             | The behaviour is a side-quest the user might not expect — opening a calendar, sending an email.       |
| Running the handler is cheap / read-only / non-egressing.                                               | Running the handler has external effects (writes, sends, costs money).                                |
| The model's reasoning is what should pick the moment of invocation.                                     | The user's consent is what should pick the moment of invocation.                                      |
| Example: "look up today's notes."                                                                       | Example: "send a summary to your colleague."                                                          |

Tagging guidance: behaviours that egress user data outside the
local store SHOULD use OFFER **and** carry the
`tool.may_egress_user_data` tag. The tag is filter-side belt and
braces — it stops the behaviour loading at all under `scope.sensitivity = high`.

### 7.4 Persistence

| Mode  | Where it shows up in the DB                                                                                                                                                                                  |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| AUTO  | If the model calls the tool: one `messages` row (role `assistant`, `tool_calls`) + one `messages` row (role `tool`, `tool_results`) per the standard primary loop (`005 §5.5`). If the model never calls it: no new `messages` rows; `metadata.behaviours_loaded[]` on the assistant message records that B was loaded but not invoked. |
| OFFER | No new `messages` rows at the moment of offering. The offer chip is part of the synthesis bundle (`005 §5.9`) and lives on the assistant message's `metadata.offers[]`. On confirm, one `messages` row (role `assistant`, `metadata.from_offer = <behaviour_id>`) is appended. |

This way the audit trail makes it possible to ask "how often did
behaviour B's offer fire, and what fraction of offers were
accepted?" with two SQL queries over `messages.metadata`. Both
fields land in the JSON Schema for `Message` (`004_SCHEMAS.md`).

---

## 8. Conflict resolution

"Conflict" here is overloaded — three distinct cases, three
distinct rules.

### 8.1 Many behaviours match the same intent

The classifier may legitimately match several behaviours for one
user message. Default is **load all of them**, subject to the
surface cap. AUTO behaviours coexist as parallel tool offerings;
OFFER behaviours coexist as parallel chips. The model and the
user resolve the actual choice downstream.

If the loaded set would exceed the surface cap (§5.1, §6.2), the
runner keeps the lower-`priority` entries and drops the rest,
logging the omissions to `llm_calls.metadata.behaviours_dropped[]`.

### 8.2 Two behaviours contribute contradictory prompt stanzas

Real example: behaviour A says "respond in three bullets max,"
behaviour B says "be exhaustive and itemise every assumption."
The runner does not try to reconcile the prose. It concatenates
both stanzas, lower-`priority`-first. The model sees whichever
the author of behaviour A or B intended to dominate, by
construction of the priority numbers they chose.

This is intentional: the runner is not a policy engine, the
plugin author is. Two plugins that habitually contradict each
other will surface as user complaints; the resolution is for
the plugin authors to coordinate via `priority`, not for the
runner to merge their text.

### 8.3 Two behaviours contribute the same tool name

A genuine bug — two unrelated plugins should not advertise
`notes.search` with different schemas. Resolution:

1. The behaviour with the lower `priority` wins, its `ToolSpec`
   enters the surface, the loser is dropped with a warning.
2. The host emits a structured warning at registration time when
   it detects that two registered behaviours have overlapping
   `tools[].name`, so the conflict surfaces at activation, not
   at the first user turn that triggers both.

This is one place where the dataclass shape pays off: the
registry can detect this at `register_behaviours` time by
folding over `tools[].name` across the entries it already
holds. The plugin author hears about the collision before any
user does.

### 8.4 Same behaviour, same turn, fired by two triggers

A behaviour with two `intent:` triggers might match both for a
single user message. The runner dedupes by behaviour `id` before
loading — the behaviour loads exactly once, regardless of how
many of its triggers matched. The set of matched trigger indices
is preserved in `llm_calls.metadata.behaviour_match[]` so the
operator can later see "trigger A and trigger B both fired" if
that diagnostic is useful.

### 8.5 OFFER chip flood

The same surface cap that bounds AUTO tools bounds OFFER chips —
the UI is not asked to render an unbounded list. The default cap
on visible OFFERs is 3 (configurable per agent via
`agent_context.user_overrides.offers.cap`). Chips beyond the cap
are queued internally but not rendered; if the user dismisses the
visible chips the next turn promotes the queued ones. This is a
UX detail the frontend spec will refine; the contract is just
that the backend hands the UI a bounded list per turn.

---

## 9. Observability

Every classifier call writes one `llm_calls` row, with metadata
fields that make post-hoc analysis possible without joining
against the registry:

```json
{
  "candidates": 18,                       // survivors after §5.1
  "matched_indices": [3, 7],              // classifier output
  "behaviours_loaded": [                  // resolved against the per-turn map
    "example-notes:summarise_daily",
    "example-reminders:propose"
  ],
  "behaviours_dropped": [],               // cap-related drops
  "mode_breakdown": {"AUTO": 1, "OFFER": 1}
}
```

The assistant message's `metadata.behaviours_loaded[]` mirrors
that final list so downstream queries (the cost dashboard, the
"what fired?" debugger) can read it without a second join.

Structured logs add `behaviour.id`, `behaviour.mode`,
`trigger.index`, and `classifier.reason` alongside the
`005 §9` fields. The per-turn debugger UI groups all
behaviour-related rows under a single collapsible "Behaviours"
section keyed on the user message id.

---

## 10. End-to-end example

A walkthrough of a single turn that exercises both modes.

**Plugin state** (active, in priority order):

| id                              | mode  | priority | intent trigger                                            |
|---------------------------------|-------|----------|------------------------------------------------------------|
| `example-notes:summarise_daily` | OFFER | 100      | user asks for a summary of today's notes                   |
| `example-reminders:propose`     | OFFER | 100      | user mentions a future commitment without a reminder       |
| `example-tone:be_brief`         | AUTO  | 50       | user message is short and conversational                   |

**User message:** "morning! quick — what do my notes say about
the dentist?"

**Step ② (EP):** user message persisted.

**Step ③ (scope):** `intent = command`, `sensitivity = normal`,
`action = proceed`.

**Step ④ (sizer):** small-class model.

**Step ⑤ (behaviour load + classifier):**

- `registry.for_agent` returns all three behaviours.
- Filtering keeps all three (no scope-driven drops).
- Classifier prompt enumerates three situations.
- Classifier returns `{ "matches": [1, 3], "reason": "asks about
  notes and is conversationally brief" }`.
- Resolved loaded set:
  - `example-tone:be_brief` (AUTO, priority 50)
  - `example-notes:summarise_daily` (OFFER, priority 100)

**System prompt at the primary:**

```
[ agent identity, defaults ]
[ user facts ]
[ scope hint: command / normal ]
[ behaviours active this turn ]
  - behaviour example-tone:be_brief:
      Keep responses to two sentences when the user is brief.
  - behaviour example-notes:summarise_daily:
      If the user asks about today's notes you may call
      the `notes.summarise_daily` tool. Prefer it to
      answering from memory.
[ end behaviours ]
```

**Tool surface:** the host's defaults plus `notes.summarise_daily`.

**Step ⑥ (primary):** the model decides to call
`notes.summarise_daily` with `{ topic: "dentist" }`. The tool
result comes back; the model emits a brief two-sentence answer.

**Step ⑨ (synthesis):** the response is sent with one OFFER chip
attached: "Want me to summarise everything in your dentist notes
folder too?" (from `example-notes:summarise_daily`, since its
*offer-side* body fires when the user asks about notes but only
got a partial answer — distinct from the AUTO tool call).

**Observability:** one `llm_calls` row with role
`behaviour_classifier`, `metadata.behaviours_loaded = [be_brief,
summarise_daily]`, `metadata.matched_indices = [1, 3]`. The
assistant message carries `metadata.offers = [{ behaviour_id:
"example-notes:summarise_daily", … }]`.

If the user clicks the chip, that produces a follow-up user
message with `metadata.confirms_offer =
"example-notes:summarise_daily"`. The runner skips
scope/sizer/primary and invokes the handler; the
`BehaviourResult` is rendered as an assistant message with
`metadata.from_offer` set.

---

## 11. Reserved for later specs

Deliberately out of scope, to be specified in follow-ups:

- **Wire schemas.** The Pydantic / Zod artefacts for
  `BehaviourMatchResult`, `BehaviourInvocation`, `BehaviourResult`,
  and the `metadata.offers[]` shape on `Message` are owned by
  `004_SCHEMAS.md` and added there once this design stabilises.
- **Background-only behaviours.** `cron:` and `schedule:`
  triggers fire without a user message; their integration with
  the turn pipeline is the same reserved spec called out in
  `005 §10`.
- **Per-user learned ranking.** A future spec may replace the
  static `priority` field with a per-user score that learns from
  offer-accept rates and from how often AUTO tools the model
  loaded were actually called. The data is already in
  `llm_calls.metadata.behaviours_loaded[]` and the assistant
  message metadata; the policy is not.
- **Cross-plugin behaviour composition.** Today behaviours are
  independent. A future spec may allow a behaviour to declare
  that it requires another (`requires: ["core-auth:identify"]`)
  so the registry loads them together, and may allow priority
  to apply at the group level. This is a generalisation of the
  conflict rules in §8 and is intentionally not in the MVP.
- **Quotas.** Caps on the number of OFFER chips a single plugin
  can produce per day per user, to prevent a noisy plugin from
  dominating the UI. The hooks exist (every chip is logged) but
  the enforcement policy is not specified here.
