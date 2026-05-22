# 008 — Subagent invocation

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Subagents, Agentic loop),
`docs/001_PLUGINS.md` (§2.2 PluginContext, §5 Behaviours and triggers),
`docs/003_MEMORY_DDL.md` (§3 `messages` and `parent_message_id`,
§9 `llm_calls`), `docs/004_SCHEMAS.md` (`agentic/*` DTOs),
`docs/005_AGENTIC_LOOP.md` (§5.2 scope, §5.5 primary loop, §5.8
critic, §5.10 agent router, §8 Subagents),
`docs/006_BEHAVIOURS_TRIGGERS.md` (§5 classifier),
`docs/007_PROVIDER_ABSTRACTION.md` (§2 Provider protocol)

This document specifies the **spawn primitive** the parent agent
uses to invoke any child computation that crosses an LLM-call
boundary inside the same turn — or that escapes a turn entirely as
a fresh nested turn. It nails down:

- The single spawn API, its inputs (context, model hint, tool
  subset, system-prompt override), and its result envelope.
- The two flavours that share the API: `helper` (one normalised
  LLM call) and `turn` (a recursive `run_turn` invocation).
- The context-passing rule: child computations inherit **nothing**
  from the parent's `TurnContext` except what is passed
  explicitly.
- The persistence story: every row a child writes hangs off the
  parent's anchor via `messages.parent_message_id` and / or
  `llm_calls.message_id`, so a subtree is reconstructible from
  SQL alone.
- The cancellation and timeout semantics, including how a
  cancelled spawn cleans up its in-flight provider call without
  unwinding the parent turn.

The same primitive backs the scope classifier (`005 §5.2`), the
sizer (`005 §5.3`), the summariser (`005 §5.5`), the behaviour
classifier (`006 §5`), the failure-detector escalations
(`005 §5.7`), the conditional critic (`005 §5.8`), the agent
router (`005 §5.10`), **and** the nested subagent turn
(`005 §8`). One concept, one set of rules, one place to add a
new role.

Out of scope (deferred to follow-ups, see §11):

- The wire shapes (DTOs) for `SpawnRequest` / `SpawnResult` —
  owned by `004_SCHEMAS.md` once stable.
- The bus-event payload an agent router publishes to wake a
  subagent handler — `005 §10`'s reserved spec covers that.
- Cross-process spawn (a subagent that runs on another worker
  node). Today every spawn is in-process on the same worker;
  scaling out is a follow-up.

---

## 1. Vocabulary

| Term                  | Meaning                                                                                                                                                          |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Spawn**             | The act of starting a child computation from the parent turn runner. Always returns a `SpawnResult` envelope.                                                    |
| **Parent**            | The `run_turn` invocation that calls `spawn(...)`. Owns the anchor `messages.id` every spawned row attributes back to.                                            |
| **Child**             | The computation invoked by spawn. Either a `helper` (single normalised provider call) or a `turn` (nested `run_turn`).                                            |
| **Helper spawn**      | One `Provider.start_call` (`007 §2`). Writes one `llm_calls` row; writes a `messages` row only when the helper's contract calls for one (critic rewrite, etc.). |
| **Turn spawn**        | A recursive `run_turn` call. Writes every row a normal turn writes; the subtree is rooted at `parent_message_id`.                                                |
| **Spawn role**        | The `llm_calls.role` value the child writes. Drawn from a closed set; new roles ship as additive migrations to `llm_calls_role_chk` (`003 §9`, `005 §7`).         |
| **Context bundle**    | The explicit, immutable inputs the parent hands to the child. The child cannot reach into the parent's `TurnContext` for anything not in the bundle.              |
| **Anchor message**    | The parent `messages.id` every child's `llm_calls.message_id` and (for turn spawns) the child's first `messages.parent_message_id` point at. Almost always the inbound user message (`005 §5.1`). |
| **Depth**             | The `trace.depth` counter on `TurnContext` (`005 §9`). User-driven turns start at `0`; every turn spawn increments. Helper spawns do not.                          |

The two flavours are named, not numbered, because the parent
code site reads cleanly either way (`spawn_helper(...)` vs
`spawn_turn(...)`) and the runner branches on the flavour to pick
between `Provider.start_call` and `run_turn`.

---

## 2. Why a single primitive for both

The plausible alternatives are: (a) hand-roll every helper
(scope, sizer, classifier, summariser, critic, router) as its own
ad-hoc function and keep "subagent" as a separate recursive
`run_turn` entrance; (b) abstract only the helper path and leave
turn spawns inlined in `run_turn`; (c) unify both behind one
spawn API.

Eidan chooses **(c)** because:

- Every child crosses the same two boundaries — context
  isolation and parent linkage — so the rules around those
  boundaries should live in one place, not seven.
- Cancellation semantics are awkward to retrofit after the fact.
  Helpers that did not start life cancellable end up needing a
  refactor when the per-turn deadline trips (`005 §6.2`); a
  uniform spawn surface makes cancellation a property of the
  primitive, not of each caller.
- Observability wants one shape. The per-turn debugger reads a
  single SQL query (`005 §9`); the rows it joins all use the
  same `parent_message_id` and `request_id` conventions. A
  helper that forgets one breaks the debugger silently. A spawn
  primitive cannot.
- Adding a new role (e.g. a future `verifier` or
  `tone_critic`) becomes: pick a name, pick a flavour, write a
  prompt. No new plumbing.

Tradeoff accepted: the primitive carries some extra parameter
surface that a hand-rolled helper would avoid. The §3.1 dataclass
keeps the cost to "one frozen dataclass with sensible defaults" —
callers pass the two or three fields that vary.

---

## 3. The spawn protocol

The runner exposes one entry point. The signature lives next to
`TurnContext` so every step that already has `ctx` in scope has
spawn in scope too.

### 3.1 `SpawnRequest`

```python
# eidan/runner/spawn.py
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping, Sequence

from eidan.providers.messages   import Message, ToolDef
from eidan.providers.accounting import CacheHints
from eidan.runner.cancellation  import CancelToken


class SpawnFlavour(str, Enum):
    HELPER = "helper"  # one Provider.start_call
    TURN   = "turn"    # a recursive run_turn


@dataclass(frozen=True, slots=True)
class SpawnRequest:
    """Everything a child needs in order to run.

    Frozen so the runner can hash it for idempotency, log it
    intact, and pass it across an async boundary without worrying
    about mutation under its feet.
    """
    # --- identification -----------------------------------------
    role:              str                  # `llm_calls.role`, 003 §9
    flavour:           SpawnFlavour
    request_id:        str                  # parent-supplied; lands
                                            # in `llm_calls.request_id`

    # --- targeting ----------------------------------------------
    model:             str                  # the model string the
                                            # registry resolves (007 §10)
    system:            str | None           # the FULL system prompt the
                                            # child sees; no inheritance
    messages:          Sequence[Message]    # the FULL message context
                                            # the child sees
    tools:             Sequence[ToolDef] = ()
    tool_choice:       str | None = None    # "auto" | "required" | name
    response_format:   dict | None = None   # JSON Schema (007 §3.3)
    cache:             CacheHints | None = None

    # --- linkage ------------------------------------------------
    parent_message_id: str                  # anchor (`messages.id`)
    parent_user_id:    str                  # owner of the parent turn
    parent_agent_id:   str | None           # parent's agent_id, if any

    # --- behaviour ----------------------------------------------
    timeout_s:         float                # per-call (helper) or
                                            # per-turn (turn) deadline
    cancel_token:      CancelToken          # see §7
    depth:             int                  # parent's depth + 0 (helper)
                                            # or parent's depth + 1 (turn)
    metadata:          Mapping[str, object] = field(default_factory=dict)
```

A few rules baked into the dataclass:

- `system` is **the full system prompt the child sees**, not a
  delta against the parent's. The parent computes whatever
  composition rules apply (`006 §6.1`) and hands the result
  over. The child does not re-invoke `006 §6.1`.
- `messages` is **the full chronological context**. For a helper
  the runner has typically pruned this aggressively (scope
  classifier sees only the last ~6 messages; `005 §5.2`); for a
  turn it is usually empty (the child loads its own history from
  the DB by `conversation_id`).
- `tools` is the **tool subset** the child is allowed to call.
  Defaults to empty — most helpers want no tools, and a child
  that needs tools must say so.
- `parent_message_id` is mandatory. There is no top-level entry
  to spawn — the runner enters its first turn via `run_turn`,
  not via `spawn`. Every spawn descends from a `messages.id` that
  was already committed.

### 3.2 `SpawnResult`

```python
@dataclass(frozen=True, slots=True)
class SpawnResult:
    """The envelope the parent receives back.

    The same shape covers helper and turn flavours. Fields that
    do not apply to a given flavour are `None` or empty, never
    omitted.
    """
    # --- outcome ------------------------------------------------
    ok:              bool                   # False on any error
    error:           SpawnError | None = None  # §6.2; populated when !ok

    # --- content ------------------------------------------------
    text:            str = ""               # the child's final text
    tool_calls:      Sequence[dict] = ()    # the child's last tool_use
                                            # blocks, if any
    structured:      object | None = None   # parsed object when
                                            # `response_format` was set

    # --- persistence handles ------------------------------------
    llm_call_ids:    Sequence[str] = ()     # every `llm_calls.id` the
                                            # child wrote, in order
    message_ids:     Sequence[str] = ()     # every `messages.id` the
                                            # child wrote (empty for
                                            # plain helpers)
    final_message_id: str | None = None     # convenience: the last
                                            # assistant message id, if
                                            # any; equals
                                            # message_ids[-1] when set

    # --- accounting ---------------------------------------------
    input_tokens:    int = 0                # summed across child calls
    output_tokens:   int = 0
    cache_read_tokens:     int = 0
    cache_creation_tokens: int = 0
    cost_usd:        float = 0.0
    latency_ms:      int = 0                # wall time inside spawn(...)

    # --- diagnostics --------------------------------------------
    truncated:       bool = False           # any child call hit a
                                            # max-tokens / partial-stream
                                            # condition (007 §4.4)
    metadata:        Mapping[str, object] = field(default_factory=dict)
```

The result is **always** returned — even on failure. `ok=False`
with a populated `error` is how the runner reports a failed
spawn back to its caller; raising from inside `spawn(...)` is
reserved for *runner* bugs (programmer errors), not for child
failures. This keeps every caller's code path linear: it reads
`result.ok` and decides.

### 3.3 The entry point

```python
async def spawn(ctx: TurnContext, req: SpawnRequest) -> SpawnResult: ...
```

`spawn` is a coroutine on the runner module, not a method on
`TurnContext`, so a test fixture can build a degenerate context
and call spawn directly without instantiating a real turn.

The function body is short: dispatch on `req.flavour`, run the
matching path, fold the rows the path wrote into `SpawnResult`,
return.

```python
async def spawn(ctx: TurnContext, req: SpawnRequest) -> SpawnResult:
    assert_spawn_invariants(req, ctx)            # §3.4

    started = monotonic()
    try:
        if req.flavour is SpawnFlavour.HELPER:
            outcome = await _spawn_helper(ctx, req)
        else:
            outcome = await _spawn_turn(ctx, req)
    except SpawnRunnerError:
        raise
    except Exception as e:
        outcome = _outcome_from_unhandled(e)     # §6.2

    return _envelope(req, outcome, started)
```

### 3.4 The invariants the runner asserts

Before either path runs, the runner checks:

- `req.parent_message_id` exists in `eidan.messages` and is not
  soft-deleted.
- `req.parent_user_id` matches `messages.user_id` for that row
  (no cross-user spawn).
- `req.depth ≤ max_depth` (default 3; `005 §8`). Helper spawns
  do not change depth; turn spawns must have `depth = parent.depth + 1`.
- `req.role` is in the closed set the migration ships (§9).
- `req.flavour == TURN` implies `req.cancel_token` is a child of
  `ctx.cancel` (see §7.1); a turn spawn that ignores parent
  cancellation is a bug.

A failed invariant raises `SpawnRunnerError`, which is the only
exception `spawn` lets propagate. Production code never catches
it; tests do.

---

## 4. Context-passing rules

The single load-bearing rule:

> A child sees exactly the context the `SpawnRequest` carries.
> Nothing else is inherited.

This is the property the issue calls "no parent memory
inheritance." It is enforced by construction: the helper path
calls `Provider.start_call` with `system` and `messages` taken
from the request, never from `ctx`; the turn path calls
`run_turn` with a fresh `TurnContext.detach(req)` that exposes
only what the request authorised.

### 4.1 What the child does NOT inherit

| Not inherited                                     | Why                                                                                                                                |
|---------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|
| Parent's full `messages` history                  | Helpers should run on the leanest context that does the job (`005 §5.2`). Turns load their own history from the DB by `conversation_id`. |
| Parent's `system` prompt and behaviour stanzas    | Behaviours loaded for the parent's primary call (`006 §6.1`) are a parent concern. A child has its own purpose and its own stanza.   |
| Parent's tool surface                             | Tools the parent loaded under `scope = proceed / normal` may be wrong for a child operating under a different `scope` or no scope.   |
| Parent's `scope` decision                         | The scope classifier *is* a spawn; using a parent scope inside a spawn would be circular. Turn spawns run their own scope step.      |
| Parent's `user_overrides` (agent_context)         | A subagent has its own `agent_id` and its own override slot; mixing them would let a parent agent silently leak preferences.          |
| Parent's `cache_control` anchors                  | Caching is keyed on the prompt prefix the *child* sends (`007 §5`). The parent's anchors are not portable.                            |
| Provider-side `prompt_cache_key`                  | Set per-call by the adapter (`007 §9.2`) keyed on `(agent_id, role)`. A child gets its own key.                                       |
| In-memory variables on `TurnContext` not listed in §4.2 | If it isn't on the bundle, it isn't reachable. The detached context (§4.3) does not expose `ctx.providers.last_call` etc.       |

This list is exhaustive in spirit. The point is that the child's
behaviour is a function of `SpawnRequest` alone — re-issue the
same `SpawnRequest` against the same DB state and you get the
same row shape back.

### 4.2 What the child DOES inherit

The detached context still exposes:

- `ctx.repo` — the persistence layer. The child needs it to
  write its own rows.
- `ctx.providers` — the provider registry (`007 §6`). The
  child needs it to call its chosen model.
- `ctx.tools` — the registry of tool definitions (`006 §4.2`),
  filtered by `req.tools`.
- `ctx.trace` — structured-log context with `parent_message_id`
  and `depth` pre-populated; the child's log lines carry both
  without per-call boilerplate.
- `ctx.cancel` — the parent's cancel token, wrapped as a child
  via §7.1.

It does NOT expose:

- `ctx.behaviours` — behaviours are loaded against the parent's
  agent; a child agent gets its own load.
- `ctx.user_msg` — the parent's anchor lives in `req.parent_message_id`;
  a child should not use the parent's user-message object as a
  data source.
- `ctx.history` — likewise.

### 4.3 The detached context

```python
class TurnContext:
    def detach(self, req: SpawnRequest) -> "TurnContext":
        """Return a child context shaped for a spawn.

        The child's `repo`, `providers`, and `tools` come from
        self; everything else is rebuilt from `req`. The child's
        `cancel` is a new `CancelToken` linked into self.cancel
        (§7.1).
        """
        return TurnContext(
            repo       = self.repo,
            providers  = self.providers,
            tools      = self.tools.scoped(req.tools),
            trace      = self.trace.child(
                              parent_message_id = req.parent_message_id,
                              role              = req.role,
                              depth             = req.depth,
                          ),
            cancel     = self.cancel.child(req.timeout_s),
            # The fields a fresh turn will populate:
            user_msg   = None,
            history    = (),
            behaviours = (),
            scope      = None,
        )
```

The detached context is what `_spawn_turn` passes to
`run_turn`. The helper path does not need a `TurnContext` and
goes straight to `provider.start_call`, but it still threads
`ctx.trace.child(...)` so its log fields line up.

### 4.4 The implication for tests

A helper test calls `spawn(degenerate_ctx, SpawnRequest(...))`
and asserts on the returned `SpawnResult`. No mocking of the
parent's history, behaviours, or scope — the spawn cannot see
them. This is the test-ergonomic payoff of §4.1 + §4.3.

---

## 5. Subtree storage

Persistence is the second half of the contract. The rules are
short; their interaction with `parent_message_id` is where the
detail lives.

### 5.1 The anchor

Every spawn carries `req.parent_message_id`. That row is the
**anchor** for the child's persisted footprint:

- Every `llm_calls` row the child writes sets
  `message_id = req.parent_message_id`. (For helper spawns this
  is direct; for turn spawns each *internal* call inside the
  nested turn still attributes back here, because the per-turn
  cost rollup in `005 §9` walks one anchor at a time.)
- The child's first `messages` row (turn spawns only — helpers
  do not normally write `messages`) sets
  `parent_message_id = req.parent_message_id`.
- All subsequent `messages` rows the child writes inside a
  nested turn link **within** the child's own tree (the
  assistant turn's `parent_message_id` is the user/anchor row;
  tool turns' `parent_message_id` is the assistant turn). This
  is the existing pattern from `005 §5.5`; the spawn primitive
  does not change it.

The effect: the subtree under the parent's anchor row is
discoverable with one `idx_messages_parent` index scan
(`003 §10`).

### 5.2 Helper spawn — what gets written

| Step                          | Row written                                                                                                                 |
|-------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| Child LLM call starts         | nothing yet                                                                                                                  |
| Child LLM call completes      | 1 `llm_calls` row, `role = req.role`, `message_id = req.parent_message_id`, accounting fields populated                       |
| Child opted to write a result | 0 or 1 `messages` row, role `assistant`, `parent_message_id = req.parent_message_id`, `metadata.spawn_role = req.role`        |

The default is **zero `messages` rows**. The scope classifier,
sizer, behaviour classifier, summariser, and agent router all
follow this shape — their effect is observable only via the
`llm_calls` ledger plus whatever metadata they wrote onto the
anchor message.

The critic in `rewrite` mode (`005 §5.8`) is the one default
caller that asks for a `messages` row. It does so by setting
`metadata.emit_message = True` on the `SpawnRequest`; the
runner reads that flag inside `_spawn_helper` and writes the
follow-up assistant row before returning.

### 5.3 Turn spawn — what gets written

A turn spawn invokes `run_turn(child_req, child_ctx)`. The
nested turn writes exactly the same row shape any turn does
(`005 §5–§5.10`), with two extras at the top:

1. The child turn's **first** persisted `messages` row carries
   `parent_message_id = req.parent_message_id`. For a subagent
   triggered by the agent router, this row is a synthetic
   `system` message that records why the subagent was invoked
   (the router's `reason` plus any payload from the bus event).
   The role is `system`; the content is short; the metadata
   carries `from_router = true`.

2. Every `llm_calls` row inside the nested turn carries
   `message_id` set to whichever child message is the natural
   anchor for that call (e.g. the child's user/system row for
   the child's scope classifier, the child's user/system row
   for the child's primary, etc.). The **parent's** anchor is
   reachable transitively through the child's anchor row's
   `parent_message_id`; we do not duplicate the parent anchor
   on every child row.

The cost rollup in `005 §9` works as-is. To get a turn's
**direct** cost: `WHERE message_id IN (...children of anchor...)`.
To get a turn's **total** cost including subtree:
recursively follow `parent_message_id`. Both queries are
single-pass with the existing indexes (`003 §10`).

### 5.4 Conversation boundaries

A turn spawn may either:

- Run inside the parent's `conversation_id`. Used when the
  subagent is logically part of the same thread — e.g. the
  user asks "and also book it" and a `book` subagent fires
  inside the same conversation.
- Run inside a **fresh** `conversation_id` owned by the
  subagent's agent. Used when the subagent represents
  background work that should not pollute the user's thread —
  e.g. an indexing agent invoked by the agent router. The
  subagent creates its own `conversations` row whose
  `metadata.parent_conversation_id` carries a back-link for
  joins.

The choice is made by the caller and recorded in
`SpawnRequest.metadata.conversation_strategy`. The runner
defaults to `same_conversation` for parent-initiated turn
spawns and `new_conversation` for agent-router-initiated turn
spawns (the agent router is post-response, so polluting the
user's thread mid-rendering is unwanted).

In either case, **`parent_message_id` reaches across
conversations**. This is the property `003 §3` calls out
explicitly: subagent subtrees are discoverable regardless of
`conversation_id`.

### 5.5 Example tree

A user-driven turn that invokes the scope classifier (helper),
runs the primary, hits the failure detector, fires the critic
(helper, rewrites), and post-response triggers one subagent
(turn) looks like:

```
messages (parent_message_id)        llm_calls (message_id)
─────────────────────────────       ────────────────────────
user_msg            (anchor)        scope_classifier
                                    sizer
                                    behaviour_classifier
                                    primary
  assistant         (← user_msg)    primary
    tool            (← assistant)   (none)
                                    primary (next round-trip)
  assistant_2       (← user_msg)    critic (rewrite emit)
                                    agent_router
                                    subagent ──────────────┐
                                                           │
  system            (← user_msg)    (subagent's scope)     │
                                    (subagent's sizer)     │
    user            (← system)      (subagent's primary)   │
      assistant     (← user)                               │
        tool        (← assistant)                          │
      assistant_2   (← user)        (subagent's critic) ◀──┘
```

Every row has one well-defined parent. `idx_messages_parent`
scans the subtree under `user_msg` in one pass.

---

## 6. Result shape

The `SpawnResult` from §3.2 normalises both success and failure.
This section pins down what each field carries for each
flavour, and how errors are typed.

### 6.1 Success — helper

A successful helper produces:

- `text` — the model's final assistant text, if any. Empty when
  the helper's prompt asked for a tool call only or for
  structured output only.
- `tool_calls` — the last assistant turn's `tool_use` blocks.
  Almost always empty for helpers (helpers usually run with no
  tools), but the field is wire-stable so the same parser
  serves both flavours.
- `structured` — the parsed object when `response_format` was
  set (`007 §3.3`). The scope classifier, behaviour classifier,
  and critic all read this field instead of `text`.
- `llm_call_ids` — one element.
- `message_ids` — empty unless the helper opted to emit a
  message (§5.2).
- Accounting fields summed from the single child call.

### 6.2 Success — turn

A successful turn spawn produces:

- `text` — the final assistant message's text, after the child
  turn's own critic and synthesis (`005 §5.9`).
- `tool_calls` — empty (a final synthesised turn never has
  pending tool_use blocks; if it did, the child turn was not
  done).
- `structured` — empty unless the child turn's last call set
  it.
- `llm_call_ids` — every `llm_calls.id` the nested turn wrote,
  in chronological order.
- `message_ids` — every `messages.id` the nested turn wrote,
  in chronological order. `final_message_id` is the last
  assistant message id.
- Accounting fields summed across the whole nested turn.

### 6.3 Errors

```python
class SpawnError(Exception):
    """Base. Every spawn failure category inherits from this."""
    code:        str
    retryable:   bool
    request_id:  str | None

class SpawnProviderError(SpawnError): ...
    # Wraps a normalised ProviderError from 007 §8.1. The
    # underlying type is in `error.metadata.provider_error_type`.

class SpawnTimeoutError(SpawnError):
    code = "timeout"
    retryable = True   # the caller decides; the runner doesn't auto-retry

class SpawnCancelledError(SpawnError):
    code = "cancelled"
    retryable = False  # cancellation is intentional

class SpawnDepthExceededError(SpawnError):
    code = "depth_exceeded"
    retryable = False

class SpawnInvariantError(SpawnError):
    code = "invariant"
    retryable = False   # bug; raised, not returned (§3.3 SpawnRunnerError)

class SpawnSchemaError(SpawnError):
    code = "schema"
    retryable = False
    # Used when the helper requested response_format and the
    # adapter raised ProviderBadOutputError (007 §3.3, §8.1).
```

The mapping from provider errors to spawn errors is
mechanical: every `ProviderError` in `007 §8.1` becomes a
`SpawnProviderError` whose `retryable` mirrors the provider's
flag and whose `metadata.provider_error_type` carries the class
name. The runner's higher-level retry policy (`005 §6.4`) reads
those fields.

The runner's caller (the step inside `run_turn`) decides what
to do with a `SpawnResult` where `ok=False`. The conventional
patterns:

| Caller step       | Default on `ok=False`                                                                                          |
|-------------------|-----------------------------------------------------------------------------------------------------------------|
| Scope classifier  | proceed with `default_proceed` scope (`005 §6.4`).                                                              |
| Sizer             | proceed with `agent.default` model (`005 §6.4`).                                                                |
| Behaviour classifier | proceed with `matches = []` (`006 §5.5`).                                                                    |
| Summariser        | skip compaction; continue with full history if it still fits (`005 §6.4`).                                       |
| Critic            | skip critic; primary response stands (`005 §6.4`).                                                              |
| Agent router      | skip routing; subagents do not fire (`005 §6.4`).                                                                |
| Subagent (turn)   | log; the user-facing turn is already complete by the time agent-router-triggered subagents run.                  |

The point of routing each failure to a sensible default rather
than re-raising is that every spawn is **optional** from the
parent's perspective. A spawn that fails reduces the turn's
quality; it does not fail the turn.

### 6.4 Partial results

Two distinct partial cases:

- **Helper stream aborted mid-message.** The provider streamed
  some content, then the connection dropped. The helper writes
  one `llm_calls` row with `truncated_reason = "stream_aborted"`
  and returns `ok=False` with a `SpawnProviderError`. Whatever
  text streamed is preserved on `result.text`; the caller may
  use it or discard it. (Helpers generally discard it because
  partial classifier output is unusable.)

- **Turn aborted by per-turn deadline.** The nested turn's own
  per-turn deadline trips (`005 §6.2`) before the child's
  synthesis. The nested turn persists its partial state by its
  own rules; the `SpawnResult` returned to the parent carries
  `truncated=True`, populated `message_ids` for what did get
  written, and `ok=False` with a `SpawnTimeoutError`. The
  parent decides whether to surface the partial subtree.

In both cases the `llm_calls` ledger is honest — every call
that consumed tokens has a row.

---

## 7. Cancellation and timeouts

### 7.1 The cancellation token

`CancelToken` is a small async-aware primitive owned by the
runner. Two operations matter:

```python
class CancelToken:
    def child(self, timeout_s: float) -> "CancelToken":
        """Return a child token that cancels when self cancels OR
        when `timeout_s` has elapsed."""

    async def wait(self) -> None: ...
    def cancel(self) -> None: ...
    @property
    def cancelled(self) -> bool: ...
```

The parent's `ctx.cancel` is the root for that turn. Every
spawn the parent makes uses
`req.cancel_token = ctx.cancel.child(req.timeout_s)`. When the
parent's token cancels (per-turn deadline, user navigates away,
worker shutdown), every child token cancels with it.

The child also cancels when its own deadline elapses, without
the parent cancelling.

### 7.2 Timeouts by flavour and role

| Flavour | Role                          | Default per-spawn timeout | Notes                                                                 |
|---------|-------------------------------|---------------------------|------------------------------------------------------------------------|
| helper  | scope_classifier              | 15 s                      | matches per-step deadline in `005 §6.4`                                |
| helper  | sizer                         | 15 s                      | matches per-step deadline in `005 §6.4`                                |
| helper  | behaviour_classifier          | 15 s                      | matches per-step deadline in `006 §5.5`                                |
| helper  | summariser                    | 60 s                      | matches per-step deadline in `005 §6.4`                                |
| helper  | critic                        | 90 s                      | matches per-step deadline in `005 §6.4`                                |
| helper  | agent_router                  | 30 s                      | matches per-step deadline in `005 §6.4`                                |
| turn    | subagent                      | 8 min (parent's per-turn) | a turn spawn inherits the parent's per-turn deadline as its own cap    |

The `timeout_s` on `SpawnRequest` is an **upper bound**, not a
guarantee. A child that finishes earlier returns earlier; a
child that hits the bound cancels and returns `ok=False`.

The runner enforces:

- `req.timeout_s` MAY be shorter than the table's default (a
  caller can demand a tighter budget).
- `req.timeout_s` MAY NOT be longer than the parent's remaining
  deadline. The runner clamps it down to
  `max(0, parent_deadline - now)` before building the child
  token.

### 7.3 What cancellation does

When a child's token cancels:

1. The in-flight `Provider.start_call` context manager's
   `__aexit__` runs (`007 §2.2`), which closes the upstream
   connection cleanly.
2. The helper's persistence step still writes its `llm_calls`
   row, with `error_type = "SpawnCancelledError"` (or
   `"SpawnTimeoutError"` for the deadline variant) and whatever
   tokens did flow. Audit honesty (`005 §6.5`) holds.
3. For a turn spawn, the nested `run_turn` exits at its next
   await boundary, having persisted whatever it had committed
   at that point. Its `SpawnResult` carries `truncated=True` and
   the partial `message_ids` / `llm_call_ids`.

A cancelled spawn does NOT raise out of `spawn(...)`. It
returns `ok=False` like any other failure. The caller decides
whether to react (typically: log and proceed with the per-role
default in §6.3).

### 7.4 Why cancellation is opt-out, not opt-in

Every spawn participates in cancellation by default. There is
no flag to disable it. The reason:

- A child that ignores cancellation pins resources on a
  worker for arbitrarily long after the user has gone. The
  per-turn deadline in `005 §6.2` only protects the user's
  critical path, not the worker's; a non-cancellable child
  defeats the protection.
- Cancellable-by-default makes the per-worker concurrency
  bound meaningful. The runner can size its semaphores
  knowing that a turn whose deadline trips will release its
  spawned-child slots within one event-loop tick, not
  whenever the upstream feels like answering.

A child that genuinely needs to finish its work even after
cancellation (e.g. flushing a half-written external write)
does so in the *handler* — outside the spawn — by spawning a
fresh background task that does not observe the parent's
cancel token. This is a deliberate choice: such tasks are
disconnected from the turn's lifecycle and account differently.

---

## 8. Depth, recursion, idempotency

### 8.1 Depth

`req.depth` is the child's depth. The runner asserts:

- `flavour == HELPER`: `req.depth == ctx.trace.depth` (helpers
  do not nest).
- `flavour == TURN`: `req.depth == ctx.trace.depth + 1`
  (every turn spawn is one level deeper).
- `req.depth <= max_depth` (default 3, configurable via host
  config). Exceeding it raises `SpawnDepthExceededError` —
  returned as `ok=False`, never raised out of `spawn`.

The cap protects against an infinite chain of subagents
firing each other via the agent router. Three levels (user →
agent → subagent → sub-subagent) covers the legitimate use
cases the agent router targets; a fourth is almost always a
bug.

### 8.2 Recursive turn spawns and their bus events

The agent router (`005 §5.10`) does NOT call `spawn` directly.
It publishes a bus event; the receiving `agent:` behaviour
handler (`001 §5.1`) catches the event and **then** calls
`spawn(ctx, SpawnRequest(flavour=TURN, ...))` from its own
process context.

The reason for the indirection: a turn spawn that descends from
the parent's request context inherits the parent's
cancellation. Background subagents triggered by the agent
router are decoupled — the user's turn is already rendered;
cancelling the user's turn should not cancel a separately
scheduled subagent. Bus delivery is the boundary that resets
the cancellation chain.

A behaviour handler invoked by an `agent:` trigger receives a
fresh `TurnContext` from the host (built via
`ctx.bus.consume(...)` semantics defined in `001 §2.2` and
expanded in the reserved background-only spec from `005 §10`).
It then calls `spawn` for its actual work. The depth still
increments, but the cancellation chain is rooted at the worker,
not at the original user turn.

### 8.3 Idempotency

`SpawnRequest.request_id` is the idempotency key for
`llm_calls.request_id`. Two spawns with the same `request_id`
in close succession (same row, same anchor) are not
de-duplicated — the runner writes both. Idempotency at the
spawn layer would conflict with the retry layer in `005 §6.4`:
a retried call is *meant* to write a second row.

Idempotency at higher layers (the user's submit retry; the bus
delivery's exactly-once-effective contract from `001 §5.2`) is
not the spawn primitive's concern.

### 8.4 Reentrancy

`spawn` is reentrant. A turn-spawn child may itself call
`spawn` from inside its own steps; that nested spawn carries
the grandchild's depth and the grandchild's parent-message
anchor (the *child* turn's anchor, not the original user's).

The transitive chain of `parent_message_id`s reconstructs the
full tree at query time. Tools like the per-turn debugger walk
this chain to render a collapsible subagent inspector.

---

## 9. Concrete uses

Every existing role in the runner is one spawn site. The table
below names the site, the flavour, and the SpawnRequest
construction. Every row is a real call shape in the
implementation.

### 9.1 Scope classifier — helper

```python
result = await spawn(ctx, SpawnRequest(
    role             = "scope_classifier",
    flavour          = SpawnFlavour.HELPER,
    request_id       = ctx.trace.new_request_id(),
    model            = host.config.classifier_model,   # small class
    system           = SCOPE_CLASSIFIER_PROMPT,
    messages         = ctx.repo.recent_messages(ctx.convo.id, limit=6)
                       + [ctx.user_msg],
    tools            = (),
    response_format  = SCOPE_RESULT_SCHEMA,
    parent_message_id = ctx.user_msg.id,
    parent_user_id    = ctx.user_msg.user_id,
    parent_agent_id   = ctx.convo.agent_id,
    timeout_s         = 15.0,
    cancel_token      = ctx.cancel.child(15.0),
    depth             = ctx.trace.depth,
))
if not result.ok:
    scope = DEFAULT_PROCEED                          # `005 §6.4`
else:
    scope = ScopeResult.model_validate(result.structured)
```

### 9.2 Behaviour classifier — helper

Same shape as 9.1 with `role="behaviour_classifier"`, a
larger `messages` window (last ~4 messages plus the user
message), the numbered-situations system prompt from
`006 §5.2`, and `response_format = BEHAVIOUR_MATCH_RESULT_SCHEMA`.

### 9.3 Critic — helper, optionally emits a message

```python
result = await spawn(ctx, SpawnRequest(
    role             = "critic",
    flavour          = SpawnFlavour.HELPER,
    request_id       = ctx.trace.new_request_id(),
    model            = host.config.critic_model,     # medium class
    system           = CRITIC_PROMPT,
    messages         = critic_context(ctx, primary_state, failure),
    response_format  = CRITIC_RESULT_SCHEMA,
    parent_message_id = ctx.user_msg.id,
    parent_user_id    = ctx.user_msg.user_id,
    parent_agent_id   = ctx.convo.agent_id,
    timeout_s         = 90.0,
    cancel_token      = ctx.cancel.child(90.0),
    depth             = ctx.trace.depth,
    metadata          = {"emit_message": True},      # see §5.2
))
```

On `verdict = "rewrite"` the helper path writes the new
assistant message inside `_spawn_helper` and returns its id
on `result.final_message_id`. On `verdict = "accept"` no
`messages` row is written.

### 9.4 Subagent — turn, fired from a bus-delivered behaviour

```python
async def my_agent_handler(ctx: PluginContext, trigger: TriggerEvent):
    request = SpawnRequest(
        role             = "subagent",
        flavour          = SpawnFlavour.TURN,
        request_id       = ctx.trace.new_request_id(),
        model            = trigger.payload["model_hint"],
        system           = trigger.payload.get("system_override"),
        messages         = (),                       # nested turn
                                                     # loads its own
        tools            = filtered_tools(trigger),
        parent_message_id = trigger.parent_message_id,
        parent_user_id    = trigger.user_id,
        parent_agent_id   = ctx.agent_id,
        timeout_s         = 480.0,                   # 8 min, the
                                                     # turn cap
        cancel_token      = ctx.cancel.child(480.0),
        depth             = trigger.depth + 1,
        metadata          = {"conversation_strategy": "new_conversation"},
    )
    result = await spawn(ctx.turn_ctx, request)
    if result.ok and trigger.payload.get("surface_back"):
        await ctx.bus.publish("subagent.result", {
            "parent_message_id": trigger.parent_message_id,
            "text":              result.text,
            "final_message_id":  result.final_message_id,
        })
```

The handler's `ctx.turn_ctx` is the fresh `TurnContext` the bus
delivery built for this handler (see §8.2). The subagent's own
turn runs `scope → sizer → primary → … → router` inside
`_spawn_turn`'s call to `run_turn`, and every row attributes
back to the original user's `parent_message_id` via the chain
described in §5.5.

### 9.5 Agent router — helper

Same shape as 9.1 with `role="agent_router"`, a slim system
prompt, the user message + the final assistant message as
`messages`, and `response_format = AGENT_ROUTER_RESULT_SCHEMA`.
This call runs **out-of-band**, after synthesis (`005 §5.10`),
under a fresh cancel token rooted at the worker rather than at
the user's request — see §8.2.

---

## 10. Observability

Every spawn writes one or more `llm_calls` rows, each carrying:

- `role` — the spawn role.
- `message_id` — the parent anchor.
- `request_id` — `SpawnRequest.request_id`.
- `metadata.spawn_depth` — the child's depth.
- `metadata.spawn_flavour` — `"helper"` or `"turn"`.
- `metadata.parent_request_id` — the parent step's request id,
  for chaining spawns inside a turn.
- the four token columns, `cost_usd`, `latency_ms`, and
  `error` / `error_type` on failure.

The per-turn cost SQL in `005 §9` works unchanged. To inspect a
single spawn:

```sql
SELECT *
FROM eidan.llm_calls
WHERE request_id = $1
ORDER BY started_at;
```

To inspect a subagent subtree:

```sql
WITH RECURSIVE subtree AS (
  SELECT id, parent_message_id
  FROM eidan.messages
  WHERE id = $anchor_message_id
  UNION ALL
  SELECT m.id, m.parent_message_id
  FROM eidan.messages m
  JOIN subtree s ON m.parent_message_id = s.id
)
SELECT *
FROM eidan.llm_calls
WHERE message_id IN (SELECT id FROM subtree)
ORDER BY started_at;
```

Both queries are index-bounded under the existing
`idx_messages_parent` (`003 §10`) plus
`idx_llm_calls_message`.

Structured logs add `spawn.role`, `spawn.flavour`,
`spawn.depth`, `spawn.parent_message_id`, and
`spawn.request_id`. The per-turn debugger groups all spawn
rows under a single collapsible "Spawns" section keyed on the
anchor message.

---

## 11. Reserved for later specs

Deliberately out of scope, to be specified in follow-ups:

- **Wire DTOs.** The `agentic/SpawnRequest.schema.json` and
  `agentic/SpawnResult.schema.json` shapes — owned by
  `004_SCHEMAS.md` once stable. Until then, the dataclasses in
  §3.1 / §3.2 are the in-process source of truth and do not
  cross a process boundary.
- **Cross-worker spawn.** A turn spawn that targets a peer
  worker (e.g. for hardware affinity: a GPU-bound subagent that
  must run on a specific node). The persistence shape stays
  identical; the orchestration (queueing, routing, partition
  failover) is its own spec.
- **Streaming child output back to the parent.** Today a helper
  streams to the runner (which may or may not stream onward to
  the UI), but a turn spawn does not stream its intermediate
  chunks back into the parent's stream. Whether the parent
  should be able to interleave a child's partial output into
  its own response is a UX question deferred to the streaming
  spec called out in `005 §10`.
- **Backpressure across spawn fan-out.** A behaviour that fires
  many subagents in parallel (e.g. one per item in a list) is
  not bounded by the spawn primitive itself today; the bounding
  layer lives in the calling behaviour. A future spec may pull
  fan-out concurrency control into the runner.
- **Quota-aware spawn refusal.** The scope classifier can read
  a budget and refuse a turn pre-flight (`005 §10`). The same
  hooks apply to spawn — a spawn whose role would exceed a
  per-user spawn-rate budget could be refused at the runner.
  The policy is not specified here.
- **Distributed cancellation acknowledgement.** Today
  cancellation is in-process and immediate. A cross-worker
  spawn (above) needs a cancellation ack from the remote; that
  is folded into the cross-worker spec.
