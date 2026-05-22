# 005 — Agentic loop sequence

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Agentic loop, Subagents),
`docs/001_PLUGINS.md` (§2 PluginContext, §5 Behaviours),
`docs/003_MEMORY_DDL.md` (§3 `messages`, §7 `agent_context`,
§9 `llm_calls`), `docs/004_SCHEMAS.md` (`agentic/*` DTOs)

This document specifies the **sequence of operations for a single
conversational turn**: every step from the moment the user submits a
message to the moment the final assistant response is rendered, plus
the failure / retry envelope around the whole thing.

A *turn* here is the smallest user-visible unit of agentic work: one
inbound user message in, one resolved assistant response out, with
arbitrarily many internal LLM and tool round-trips between. The
shape of those internal round-trips, what gets persisted when, and
what happens when something goes wrong are all in scope.

Out of scope (deferred to follow-up specs, see §10):

- The wire shapes (DTOs) for events and tool calls — owned by
  `004_SCHEMAS.md`.
- How background / cron-triggered behaviours fire when there is no
  inbound user message — only the turn-driven path is specified here.
- Sandboxing and quotas across plugins.

---

## 1. Vocabulary

The loop is described in terms of a small fixed cast of roles. Each
role names a kind of LLM call, and each maps onto a value of
`eidan.llm_calls.role` (`003_MEMORY_DDL.md §9`). Where the existing
`llm_calls_role_chk` does not yet cover a role used below, it is
called out in §7 as a follow-up additive migration to that
document.

| Role             | Model class    | Lives in `llm_calls.role`   | Purpose                                                        |
|------------------|----------------|-----------------------------|----------------------------------------------------------------|
| **user**         | n/a            | n/a (not an LLM call)       | The inbound message from the human.                            |
| **scope**        | small / cheap  | `scope_classifier` *(new)*  | Pre-flight: intent, sensitivity, scope, safety gating.         |
| **sizer**        | small / cheap  | `sizer` *(new)*             | Picks the model class that handles the primary call.           |
| **primary**      | sized per-turn | `primary`                   | The main agentic call; runs tool loops; emits the response.    |
| **summariser**   | small / medium | `summariser`                | Compacts history mid-loop when context grows.                  |
| **tool**         | n/a            | n/a (not an LLM call)       | Local execution of a registered tool / behaviour.              |
| **router**       | small / cheap  | `agent_router` *(new)*      | Post-response routing: which background agents react.          |
| **critic**       | medium         | `critic` *(new)*            | Conditional review of the primary response when something looks off. |
| **subagent**     | sized per-call | `subagent`                  | A nested turn spawned by a behaviour (`agent:` trigger, `001_PLUGINS.md §5.1`). |

### 1.1 "Eager persistence" (the issue's "keen save")

**Eager persistence** — abbreviated EP below — is the project rule
that every conversation-shaped artefact (user message, assistant
response, intermediate tool turn) is written to `eidan.messages`
**before** the next LLM call that depends on it is issued.

In particular:

- The inbound user message is persisted before the scope classifier
  runs.
- Each assistant tool-use turn is persisted before its tool result
  is computed.
- Each tool result turn is persisted before the next primary
  iteration is issued.
- The final assistant response is persisted before the agent router
  reads it.

The constraint is durability + replayability: if the worker crashes
between any two LLM calls, the conversation log accurately reflects
the last completed step. The next process can resume — or surface a
failure — without inferring state from in-memory variables that no
longer exist.

EP is implemented as **synchronous** writes from the backend turn
runner. We do not use an outbox / async writer for these rows
because the next step is the writer's caller — there is nothing to
gain from making the write asynchronous and a great deal to lose if
the caller proceeds with the LLM call before the row is committed.

---

## 2. Where the work lives

Three layers cooperate per turn:

```
┌──────────────────────────────────────────────────────────────────┐
│  UI (Next.js, browser)                                          │
│   • Submits user message via POST /api/turn (or WS frame)        │
│   • Renders streaming response                                   │
│   • Optimistically displays the user's own message               │
│     (NOT a persistence step — the backend is authority)          │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  HTTP / WS
┌──────────────────────────────────────────────────────────────────┐
│  Backend turn runner (Python / FastAPI)                          │
│   • Owns persistence (EP, §1.1)                                  │
│   • Drives the sequence in §3                                    │
│   • Calls providers via a typed client                           │
│   • Streams partial output back to the UI                        │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Providers + tools                                              │
│   • Anthropic / OpenAI / local model HTTP                        │
│   • MCP servers (`001_PLUGINS.md §7`)                            │
│   • Plugin behaviours (`001_PLUGINS.md §5`)                      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Postgres (`eidan.messages`, `eidan.llm_calls`, …)              │
└──────────────────────────────────────────────────────────────────┘
```

The UI's only role in persistence is **delivery**: it submits the
user message and renders the streamed response. The UI does not
write to the database. A client-side optimistic render of the user's
own message is a UX concern and is allowed; it has no semantic
status — until the backend commits the row, the message has not
happened. Offline / outbox semantics are out of scope here and will
be specified separately if and when we ship offline mode.

---

## 3. Top-level sequence

The diagram below is the canonical reference; §4 walks each step.
"EP" = eager persistence — every user, assistant, tool, and
`llm_calls` row is written before its result is forwarded.

```mermaid
sequenceDiagram
    autonumber
    participant UI
    participant BE as Backend turn runner
    participant LLM as Provider
    participant DB

    UI->>BE: POST /turn
    Note over BE: ① validate, resolve user / convo
    BE->>DB: ② EP user message — INSERT messages (role=user)

    BE->>LLM: ③ scope classifier
    LLM-->>BE: response
    BE->>DB: EP llm_calls (role=scope_classifier)

    BE->>LLM: ④ sizer
    LLM-->>BE: response
    BE->>DB: EP llm_calls (role=sizer)

    Note over BE: ⑤ load behaviours + tool surface (no LLM call)

    rect rgb(245,245,245)
        Note over BE,LLM: ⑥ primary call (loop)
        BE->>LLM: primary call
        LLM-->>UI: stream chunks
        LLM-->>BE: response
        alt model returns tool_use
            BE->>DB: EP assistant turn — INSERT messages (role=assistant, tool_calls)
            Note over BE: execute tool(s) locally
            BE->>DB: EP tool turn — INSERT messages (role=tool, tool_results)
            BE->>DB: EP llm_calls (role=primary)
            Note over BE,LLM: loop back to provider
        else final text
            BE->>DB: EP assistant turn — INSERT messages (role=assistant)
            BE->>DB: EP llm_calls (role=primary)
        end
    end

    Note over BE: ⑦ failure detector (heuristic; no LLM call unless ⑧ triggers)

    opt ⑦ flagged
        BE->>LLM: ⑧ conditional critic
        LLM-->>BE: response
        BE->>DB: EP critic turn — INSERT messages (role=assistant)
        BE->>DB: EP llm_calls (role=critic)
    end

    Note over BE: ⑨ final synthesis (deterministic)
    BE-->>UI: final response

    Note over BE,LLM: ⑩ agent router (async, after user sees response)
    BE->>LLM: agent router
    LLM-->>BE: response
    BE->>DB: EP llm_calls (role=agent_router)
    Note over BE: for each picked agent, publish bus event<br/>(out of band; parent_message_id link)
```

Notes on the diagram:

- Streaming (`◀── stream`) is independent of the persistence path.
  Chunks are streamed to the UI as they arrive, and the row is
  written when the chunk stream completes.
- Step ⑩ runs *after* the final response is on the wire to the UI.
  It is part of the same turn — its work is attributed back to the
  parent message via `parent_message_id` (`003_MEMORY_DDL.md §3`) —
  but it does not gate user-visible output.

---

## 4. Pseudocode

Reference implementation. Real code adds typing, structured logging,
and streaming; the shape stays the same.

```python
async def run_turn(req: TurnRequest, ctx: TurnContext) -> TurnResult:
    # ① validate, resolve user / convo
    convo = await ctx.repo.get_or_create_conversation(
        user_id=req.user_id,
        conversation_id=req.conversation_id,
    )

    # ② EP: persist user message
    user_msg = await ctx.repo.append_message(
        conversation_id=convo.id,
        user_id=req.user_id,
        role="user",
        content=req.text,
        agent_id=convo.agent_id,
        parent_message_id=req.in_reply_to,
        metadata={"client_id": req.client_id},
    )
    ctx.trace.attach(user_message_id=user_msg.id)

    # ③ scope classifier (cheap, lean context)
    scope = await classify_scope(
        ctx,
        user_msg=user_msg,
        recent=ctx.repo.recent_messages(convo.id, limit=6),
        user_facts=ctx.repo.user_context_slice(req.user_id, ["constraints", "preferences"]),
    )
    if scope.action == "deny":
        return await emit_denial(ctx, user_msg, scope)

    # ④ sizer (cheap)
    sized = await pick_model(
        ctx,
        scope=scope,
        convo=convo,
        rough_input_tokens=ctx.tokens.estimate_input(convo.id),
    )

    # ⑤ load behaviours + tool surface (no LLM call)
    behaviours = ctx.behaviours.for_agent(convo.agent_id, scope=scope)
    tools      = ctx.tools.surface(agent_id=convo.agent_id, scope=scope)

    # ⑥ primary call loop
    primary_state = PrimaryState(model=sized.model, behaviours=behaviours, tools=tools)
    final_assistant_msg = await run_primary_loop(ctx, convo, user_msg, primary_state)

    # ⑦ failure detector (cheap, mostly heuristic)
    failure = detect_failure(final_assistant_msg, primary_state.history)

    # ⑧ conditional critic
    if failure.should_critique:
        critic = await run_critic(ctx, convo, primary_state, failure)
        if critic.replaces_response:
            final_assistant_msg = await append_critic_replacement(ctx, convo, critic)

    # ⑨ final synthesis (deterministic — packaging, not generation)
    result = synthesise(final_assistant_msg, scope=scope, failure=failure)
    await ctx.emit_to_ui(result)

    # ⑩ agent router (out-of-band; does not block ⑨)
    ctx.background.spawn(run_agent_router, ctx.detach(), final_assistant_msg, scope)

    return result
```

The body of each step is specified in §5.

---

## 5. Step-by-step

### 5.1 Inbound and persistence (steps ① ②)

**Layer:** the backend turn runner is authoritative. The UI may
render the user's message optimistically; that does not count as a
save. The canonical `messages` row is created inside step ②, before
any provider call.

**Validation (①):**

- `TurnRequest` is parsed against the shared schema
  (`004_SCHEMAS.md`).
- `user_id` and `conversation_id` are resolved against
  `eidan.conversations`; an unknown `conversation_id` aborts with
  `404`. A missing one creates a new conversation row in the same
  transaction as the user message.
- The request carries a client-side idempotency key
  (`req.client_id`). The runner stores it in `messages.metadata`
  and refuses to start a new turn if it matches the metadata of an
  already-committed row within the last 60 s. This makes UI retries
  safe even before the response has been streamed.

**Persistence (②):** one row into `eidan.messages`, role `user`,
synchronous. The row's `id` is the trace anchor for the rest of the
turn — every subsequent `llm_calls` row carries it in
`llm_calls.message_id` (`003_MEMORY_DDL.md §9`), making the per-turn
cost rollup a simple `WHERE message_id IN (...)`.

The user message and the conversation create (if needed) commit
together. The runner does NOT acquire row locks on the conversation
beyond this commit — the DB just sees an append-only sequence. The
backend runs multi-instance, so any cross-turn coordination on the
same conversation that does need a single owner (e.g. preventing two
primary calls from racing on the same conversation) MUST be a
DB-level mechanism — Postgres commit ordering on
`messages.created_at`, an advisory lock keyed on `conversation_id`,
or a row-state guard — never an in-process mutex.

### 5.2 Scope classifier (step ③)

**Goal:** decide what kind of turn this is, with the cheapest model
that can do the job.

**Inputs (kept deliberately lean):**

- The current user message (full text).
- The last ~6 messages from `eidan.messages` for the conversation
  (oldest→newest), `content` only — no tool blocks.
- `eidan.user_context` rows in categories `constraints` and
  `preferences` (`003_MEMORY_DDL.md §8`).
- A small fixed prompt that defines the classification schema.

**Output schema** (a shared `agentic/ScopeResult.schema.json`,
defined in `004_SCHEMAS.md`):

```ts
type ScopeResult = {
  action: "proceed" | "deny" | "defer";
  intent: "question" | "command" | "chitchat" | "system";
  urgency: "low" | "normal" | "high";
  sensitivity: "low" | "normal" | "high";
  reason: string | null;
};
```

**Why a cheap model is enough.** The classifier is not making the
substantive answer — it is routing. A small Haiku-class model has
enough headroom for this five-axis classification and costs an
order of magnitude less per call than the primary. Empirically (to
be validated post-MVP) this call is well under 500 input tokens and
returns well under 100.

**On `action = deny`:** the runner skips steps ④–⑨ and emits a short
canned response keyed by `scope.reason`. The denial itself is
written as an assistant message with `metadata.system_emitted=true`
so it is distinguishable in audit. The `llm_calls` row for the
scope call still gets written.

**On `action = defer`:** the runner enqueues the turn for later
processing on a DB-backed queue (so any backend instance can claim it
via `SELECT … FOR UPDATE SKIP LOCKED`), then sends an acknowledgement
message back to the user immediately. The actual response is
delivered by a subagent path that is specified in a follow-up.

### 5.3 Sizer (step ④)

**Goal:** pick the model class for the primary call. Single output:

```ts
type SizerResult = {
  model: string;       // e.g. "claude-opus-4-7", "claude-sonnet-4-6"
  reason: string;
  budget_tokens: number;   // soft target for combined input+output
};
```

**Inputs:**

- `ScopeResult` from step ③.
- Estimated input-token count for the conversation history.
- Whether any tool in the surface (§5.5) is known to require deep
  reasoning (annotated in the tool registry).
- The agent's configured ceiling (`agent_context.user_overrides`,
  `003_MEMORY_DDL.md §7`).

The sizer is *also* a small model. The reason it is not folded
into the scope classifier is keep-each-step-cheap: the scope output
schema is closed-set and consistent across agents, while the sizer
output names a model string that the operator may want to swap per
agent or per environment. Splitting the two means a new model can be
added by changing one prompt, not two.

**Default policy** (the prompt encodes this; the implementation
does not need a separate code branch):

| Scope                                      | Default model class       |
|--------------------------------------------|---------------------------|
| chitchat / low-stakes question             | small (haiku-class)       |
| typical question or command                | medium (sonnet-class)     |
| sensitivity=high or urgency=high           | large (opus-class)        |
| tool surface requires deep reasoning       | large (opus-class)        |

The sizer may override the table for an explicit reason — the
reason is stored on the `llm_calls.metadata` row so we can later
audit how often the override fires.

### 5.4 Behaviours and tool surface (step ⑤)

**No LLM call.** This is a deterministic lookup against the plugin
registry and the agent context.

The runner builds two artefacts:

1. **System / developer prompt**, assembled from:
   - The agent's `code_defaults.system_prompt` and any user
     override of it (`agent_context`, `003_MEMORY_DDL.md §7`).
   - Behaviour-derived stanzas — each registered `agent:` behaviour
     contributes a description of itself for the model to consult.
   - User context surfaced as facts (`user_context`, categories
     `identity` and `goals`), reformatted into a short fact list.
   - The current scope decision (a hint, not an instruction).

2. **Tool surface** — a list of tool definitions matching the
   `tools[]` payload format the provider expects. Each entry's
   `input_schema` is the **same JSON Schema** that drove codegen
   for the corresponding behaviour (`004_SCHEMAS.md §8.1`). No
   second copy of the schema is hand-written here.

The set of tools is filtered by the scope:

- `scope.sensitivity = high` excludes any tool tagged
  `tool.may_egress_user_data` (e.g. third-party send tools), unless
  the user has explicitly enabled it for this agent.
- `scope.intent = chitchat` excludes write-side tools.

The set of tools is bounded — the registry caps the surface at N=32
entries by default (configurable per-agent). Exceeding the cap is a
warning, not an error; the runner picks the highest-priority subset
and logs the omission.

### 5.5 Primary call (step ⑥)

**Goal:** the substantive answer. This is the only step in the turn
that runs an interactive loop with the provider.

```python
async def run_primary_loop(ctx, convo, user_msg, state) -> Message:
    history = ctx.repo.full_history(convo.id)   # already includes user_msg
    while True:
        async with ctx.providers.start_call(
            role="primary",
            model=state.model,
            system=state.system_prompt,
            messages=history,
            tools=state.tools,
            stream=True,
            request_id=ctx.trace.new_request_id(),
        ) as call:
            assistant = await call.collect()      # streams to UI, returns final blocks

        # EP: write the assistant turn before we execute any tool.
        msg = await ctx.repo.append_message(
            conversation_id=convo.id,
            user_id=user_msg.user_id,
            agent_id=convo.agent_id,
            parent_message_id=user_msg.id,
            role="assistant",
            content=assistant.text,
            tool_calls=assistant.tool_calls,
            provider=state.provider,
            model=state.model,
        )
        await ctx.repo.append_llm_call(
            role="primary",
            message_id=msg.id,
            conversation_id=convo.id,
            user_id=user_msg.user_id,
            agent_id=convo.agent_id,
            **call.accounting(),                   # tokens, cost, latency
        )

        if not assistant.tool_calls:
            return msg                              # done — text-only turn

        # Order matters: the assistant tool_use turn must appear in
        # history before its tool_result peers.
        history = append_to_history(history, msg)

        # Tool execution. Each tool_use gets one tool-result row.
        for tool_use in assistant.tool_calls:
            try:
                result = await ctx.tools.execute(tool_use, ctx_for_tool(ctx))
            except ToolError as e:
                result = error_block(tool_use, e)   # surfaced to the model, not raised
            tool_msg = await ctx.repo.append_message(
                conversation_id=convo.id,
                user_id=user_msg.user_id,
                agent_id=convo.agent_id,
                parent_message_id=msg.id,
                role="tool",
                tool_results=[result],
            )
            history = append_to_history(history, tool_msg)

        if state.tokens_estimated(history) > state.compaction_threshold:
            history = await summarise_old_messages(ctx, history, state)
```

**Persistence shape.** Each LLM round-trip writes one
`messages` row (the assistant turn), and each tool execution writes
one further `messages` row (role `tool`, with the result block).
This means a single turn can produce many rows, all linked into the
tree via `parent_message_id` (`003_MEMORY_DDL.md §3`). Replay of a
conversation is a `SELECT … ORDER BY created_at` followed by a
client-side fold; nothing about that fold depends on in-memory
state from this run.

**Tool failures inside the loop.** A tool that raises does NOT
abort the loop. The runner converts the exception into an error
block and feeds it back to the model in the next round-trip, the
same way a real provider would handle a misbehaving tool. The
model's next message decides whether to retry, ask the user, or
give up. This is intentional: the loop is exactly what an
intelligent agent does in the face of a failed sub-step.

**Compaction.** When the running history estimate exceeds the
configured threshold, the runner triggers a `summariser` call
(`llm_calls.role = 'summariser'`) that rewrites the older half of
the history into a compact summary. The summary replaces the
original messages **in the in-memory history that's sent to the
provider**, never in the database. The DB log stays append-only;
compaction is a working-memory concern, not a curation one.

**Loop bounds.** The runner enforces an upper bound on tool-loop
iterations (default 12) to prevent a model from looping
indefinitely. Hitting the bound triggers the failure path (§5.7) —
the assistant's last turn is kept, but the failure detector flags
the response as `loop_exhausted`.

### 5.6 Persistence of the primary response

The last assistant message produced by the loop is, by construction,
already persisted by the loop's eager-persist step. There is no
separate "save final response" step — it is the same row as the
last assistant turn from §5.5. The reason we still call it out as a
distinct concern in the issue is because it interacts with §5.7 and
§5.8: the failure detector reads the just-persisted row, and the
critic (if it fires) may append a follow-up assistant message that
the UI renders instead of, or after, this one.

### 5.7 Failure detector (step ⑦)

**Goal:** decide whether the primary's final response is suspect
enough to warrant a critic pass. This step is **cheap and mostly
deterministic** — no LLM call by default. It looks at the turn's
shape, not its meaning.

Triggers (any one fires `failure.should_critique = true`):

| Signal              | Definition                                                                  |
|---------------------|------------------------------------------------------------------------------|
| `empty_response`    | `content == ""` and `tool_calls == []`.                                      |
| `loop_exhausted`    | Loop bound hit in §5.5.                                                      |
| `tool_storm`        | More than 6 tool calls in the turn with no terminal text response.            |
| `repeated_tool`     | Same `(tool_name, args)` invoked ≥ 3 times in the same turn.                 |
| `refusal`           | Heuristic match against a refusal prefix list, when `scope.action = proceed`. |
| `low_confidence`    | The primary emitted a `confidence` field on its response under a threshold.   |
| `tool_errors_left`  | The last assistant turn followed a `tool` turn whose result was an error block, and did not re-attempt or surface the error. |

The detector returns a structured `FailureSignal` with the list of
matched triggers. The signal is written to the assistant message's
`metadata.failure` field — both for the critic to read and for
post-hoc analysis. If no trigger fires the critic is skipped.

### 5.8 Conditional critic (step ⑧)

The critic runs only when §5.7 flagged something. It is a single
**medium-class** call with a prompt structured as:

- Original user message.
- The primary's final response and the list of failure triggers.
- A short context window (last ~10 messages) to give the critic
  enough to judge.

The critic returns:

```ts
type CriticResult = {
  verdict: "accept" | "rewrite" | "escalate";
  rewritten_response: string | null;   // populated iff verdict = rewrite
  reason: string;
};
```

- **accept** — the primary response stands; the critic verdict is
  recorded on the assistant message's `metadata.critic` but no new
  row is written. The user sees the primary response unchanged.
- **rewrite** — the rewritten text is appended as a NEW assistant
  message with `parent_message_id` pointing at the primary
  assistant message, `metadata.replaces_message_id` pointing at the
  same target, and `metadata.critic.verdict = "rewrite"`. The UI is
  instructed by the synthesis step (§5.9) to render the rewritten
  message instead of the original.
- **escalate** — the critic believes the answer requires the
  large-class model. The runner re-invokes the primary loop (§5.5)
  with `state.model` upgraded one tier, capped at the agent's
  ceiling. This costs one extra primary pass; it is allowed at
  most once per turn. The earlier primary response stays in the
  log; the upgraded primary's response is the one the synthesis
  step emits.

The critic is opt-in: an agent whose `agent_context.user_overrides`
sets `critic.enabled = false` skips §5.8 unconditionally and the UI
sees whatever the primary produced.

### 5.9 Synthesis (step ⑨)

**Deterministic, no LLM call.** The synthesis step packages the
chosen final assistant message (primary or rewritten) into the
shape the UI expects:

- The message's `content`.
- A pointer to its `messages.id` so the UI can reference it for
  edits, thumbs, reruns.
- The `scope`, `failure`, and `critic` artefacts (redacted where
  appropriate — the user sees a friendly "we double-checked this"
  signal but not the raw critic prompt).
- The accumulated cost from `llm_calls` rows belonging to this
  `user_msg.id` (for the cost dashboard).

Synthesis emits the bundle to the UI via the same channel that
streamed the primary tokens, then returns from `run_turn`.

### 5.10 Agent router (step ⑩)

**Out-of-band; does not block the user's response.** After step ⑨
the runner spawns a background task that runs the agent router. The
router decides which (if any) background agents should react to the
turn just completed.

Input:

- The user message and the final assistant message (content only).
- A list of agents enabled for the user
  (`agent_context.enabled = true`).
- For each agent, its self-description (from `agent_context`).

Output:

```ts
type AgentRouterResult = {
  invocations: Array<{
    agent_slug: string;        // the agent to invoke
    reason: string;
    payload: unknown;          // schema-validated against the agent's input
  }>;
};
```

For each invocation the router emits a bus event
(`ctx.bus.publish`, `001_PLUGINS.md §2.2`) carrying the parent
message id. Receiving agents register `agent:` triggers
(`001_PLUGINS.md §5.1`) and their handlers run as subagent turns
(`llm_calls.role = 'subagent'`). The subagent turn's first message
has `parent_message_id` set to the assistant message that triggered
it, so the resulting subtree is discoverable in
`idx_messages_parent` (`003_MEMORY_DDL.md §10`).

The router is cheap, like the scope classifier. It does NOT
itself execute any agent — it just publishes events. If the router
times out, the worst case is that some background reaction does
not happen; the user-facing turn is already complete.

---

## 6. Error handling

This section is the truth table for *what happens when something
breaks*. The detector in §5.7 is about a turn that completed but
looks suspect. The cases below are about a turn that did not
complete normally.

### 6.1 Provider error classes

| Class                  | Examples                                | Retryable?                |
|------------------------|-----------------------------------------|---------------------------|
| Transient network      | TCP reset, DNS, TLS handshake           | yes                       |
| Provider 5xx           | 500/502/503/504                         | yes                       |
| Rate limit             | 429, provider-side concurrency cap      | yes, with backoff hint    |
| Overloaded             | provider-specific "overloaded" code     | yes                       |
| Bad request            | 400/422 — malformed payload             | no (bug)                  |
| Auth                   | 401/403                                 | no (config)               |
| Not found              | 404 model id / resource                 | no (config)               |
| Content policy         | provider-side refusal that throws       | no                        |
| Context window exceeded| provider-specific too-large response    | no — triggers compaction  |

For retryable classes the runner uses exponential backoff with full
jitter, base 250 ms, factor 2, capped at 10 s per sleep, capped at
the per-step retry budget (§6.4). Rate-limit responses that carry a
`Retry-After` (or provider equivalent) override the computed sleep
upward, never downward.

For non-retryable classes the runner records the error on the
in-flight `llm_calls` row (`error`, `error_type`,
`003_MEMORY_DDL.md §9`) and propagates a typed exception up to the
step boundary, where §6.5 decides whether the turn fails or
degrades gracefully.

### 6.2 Timeouts

Three layered deadlines:

- **Per-call timeout** — applies to a single HTTP call to a provider.
  Default 60 s. Configurable per role: the scope classifier has a
  much tighter timeout (default 5 s) because it sits on the user's
  critical path with no value to add by waiting longer.
- **Per-step timeout** — wraps all retries of a step. Default for
  primary: 5 minutes. Default for cheap steps: 15 s.
- **Per-turn deadline** — wraps the whole turn. Default 8 minutes.
  Once it trips, in-flight provider calls are cancelled, no new
  steps start, and the runner emits a graceful timeout response
  (§6.5).

A timeout on a step that has already streamed partial content to
the UI is recorded as a partial failure (§6.3). The partial
content is NOT discarded; it is persisted with
`metadata.truncated = true`, the failure detector sees this and
flags the turn for the critic (next turn or, if the per-turn
deadline has not yet tripped, the same turn).

### 6.3 Partial failures inside the primary loop

The primary loop can fail in the middle in three distinct ways:

1. **Streaming aborted mid-message.** The provider connection
   drops after some tokens have streamed. The runner persists what
   it has with `metadata.truncated = true`, decides per retry
   policy (§6.4) whether to re-issue the call (no — partial
   streamed content has been emitted to the UI and re-issuing
   would duplicate it), and surfaces the partial response. The
   failure detector flags it.

2. **Tool execution failure.** Already handled inside the loop —
   §5.5 converts tool exceptions into error blocks. This is
   *expected*, not exceptional, and the loop continues.

3. **Loop iteration LLM call fails.** The provider call between
   tool round-trips fails permanently after retries. The runner
   persists the failure marker (a `messages` row with role
   `assistant`, empty content, `metadata.error_type = "primary_failed"`)
   and exits the loop. The failure detector flags it, the critic
   may try to salvage (`escalate` re-issues with a different model),
   but ultimately the user-facing message is "I hit an error
   completing this — here is what I did before it failed."

### 6.4 Retry policy per step

| Step                | Retries | Per-call timeout | Per-step deadline | On exhaustion                          |
|---------------------|---------|------------------|-------------------|----------------------------------------|
| Scope classifier    | 1       | 5 s              | 15 s              | proceed with `scope = default_proceed` |
| Sizer               | 1       | 5 s              | 15 s              | proceed with `model = agent.default`   |
| Primary             | 2       | 60 s             | 5 min             | failure path (§6.5)                    |
| Summariser          | 1       | 30 s             | 60 s              | skip compaction; continue with full history if it still fits |
| Tool execution      | tool-defined (default 0) | tool-defined | included in primary step | surface as error block to the model |
| Critic              | 0       | 60 s             | 90 s              | skip critic; primary response stands   |
| Agent router        | 1       | 10 s             | 30 s              | skip routing; subagents do not fire    |

The asymmetry is deliberate: the cheap, optional steps should not
hold up a turn or burn budget on retries. The primary, which costs
the most and adds the most value, gets the largest budget. The
critic gets none because it is itself a guard — a flaky critic
should not become a flaky turn.

Each retried call writes its **own** row in `llm_calls`. The
relationship is captured via
`llm_calls.metadata.retry_of = <previous_llm_call_id>`. This makes
the cost dashboard honest: a turn that retried three times shows
three rows, not one averaged row.

### 6.5 What the user sees when a turn fails

Three failure modes have distinct user-facing presentations:

- **Total failure before any content streamed.** No assistant
  message yet exists; the runner appends a system-emitted
  assistant message with a friendly error and a request ID. The
  request ID matches `llm_calls.request_id` so support can trace it.

- **Partial failure after content streamed.** The truncated content
  remains rendered. The UI receives a synthesis bundle with
  `result.error = { code, request_id, recoverable: bool }`. If
  recoverable, the UI offers a one-click "continue" that submits a
  zero-text user message with metadata flagging the previous turn —
  the next turn picks it up and resumes (the actual resume
  mechanic is described in a follow-up spec; this doc only fixes
  the contract).

- **Turn-deadline timeout.** Same as partial failure, but
  `recoverable = false` and the system-emitted message names the
  deadline explicitly so the user understands the operation was
  cut, not refused.

In all three cases the `llm_calls` rows for whatever did execute
are committed — the cost dashboard never under-reports.

### 6.6 Idempotency across retries

A retried user submission (same `client_id` within the 60 s window,
§5.1) does NOT re-enter the loop — the runner returns the existing
in-flight result or the already-committed assistant message.

A retried provider call (transient error, §6.1) does NOT create a
duplicate `messages` row, because `messages` writes happen *after*
the call returns successfully. A retry that finally succeeds writes
the row once.

A retried tool call (§6.4) DOES create one `tool` message per
attempt — each attempt's result (success or error) is its own row,
which is the cleanest thing to replay against.

---

## 7. Where work shows up in the database

Quick reference, restating the dependencies the steps above place
on `003_MEMORY_DDL.md`:

| Step                    | `messages` rows written        | `llm_calls.role`           | Notes                                       |
|-------------------------|--------------------------------|----------------------------|---------------------------------------------|
| ② user                  | 1 (role=user)                  | —                          | Anchor row for the turn's `message_id`.     |
| ③ scope                 | 0                              | `scope_classifier` (new)   | Internal only.                              |
| ④ sizer                 | 0                              | `sizer` (new)              | Internal only.                              |
| ⑥ primary (per round-trip) | 1 assistant + 1 tool per tool call | `primary`              | Eager-persisted around each LLM round-trip. |
| ⑥ summariser            | 0                              | `summariser`               | Working-memory only; DB log untouched.      |
| ⑧ critic                | 0 on `accept`, 1 on `rewrite`  | `critic` (new)             | Linked to primary via `parent_message_id`.  |
| ⑩ agent router          | 0 (subagents may add later)    | `agent_router` (new)       | Background; spawned subagent turns add their own rows under `subagent`. |

The "(new)" entries require extending the `llm_calls_role_chk`
CHECK constraint in `003_MEMORY_DDL.md §9`. This is a
non-breaking, additive migration (adds new allowed values) and
ships in a single core revision alongside the implementation that
emits them. Existing rows are unaffected.

---

## 8. Subagents in the turn

A subagent invocation is a *nested turn*. The agent router (§5.10)
publishes an event; a `agent:`-triggered behaviour
(`001_PLUGINS.md §5.1`) handles it; that handler invokes `run_turn`
recursively with:

- A new (or existing) conversation row owned by the subagent's
  agent_id.
- `parent_message_id` set to the assistant message that triggered
  it, so the subtree is discoverable.
- `llm_calls.role = 'subagent'` for the subagent's primary call.

The subagent turn re-uses the same `run_turn` pipeline — including
its own scope classifier, sizer, primary, failure detector, and
agent router. There is no "subagent fast path." This keeps one
flow to reason about and one flow to instrument.

The subagent's output is not, by default, returned to the user that
triggered the parent turn. If the subagent should surface back, it
publishes an event that the parent agent (or the UI's notifications
channel) listens for. This is deliberate: a subagent that picks up
the conversation has to do so explicitly.

Loops are prevented by a `depth` counter passed through
`TurnContext`. The default cap is 3 (turn → subagent → subagent).
Exceeding it is a structured error logged with the full chain of
`parent_message_id`s.

---

## 9. Observability

Every step records enough state in `llm_calls` and
`messages.metadata` that a single SQL query can reconstruct a
turn's shape:

```sql
SELECT
  c.role               AS llm_role,
  c.provider,
  c.model,
  c.input_tokens,
  c.output_tokens,
  c.latency_ms,
  c.error_type,
  c.cost_usd,
  m.role               AS msg_role,
  left(m.content, 80)  AS preview
FROM eidan.llm_calls c
LEFT JOIN eidan.messages m ON m.id = c.message_id
WHERE c.message_id IN (
  SELECT id FROM eidan.messages
  WHERE conversation_id = $1
    AND user_id = $2
    AND role = 'user'
  ORDER BY created_at DESC LIMIT 1
)
ORDER BY c.started_at;
```

The query returns one row per LLM call belonging to the latest
turn, in the order they happened, with the message role they wrote
(or NULL for internal calls). This is the shape the cost / latency
dashboard and the per-turn debugger consume.

Structured logs carry the same identifiers:

- `turn.id` — synonymous with the user message id.
- `turn.user_id`, `turn.conversation_id`, `turn.agent_id`.
- `llm.role`, `llm.request_id`, `llm.model`.
- `trace.depth` — 0 for user-driven turns, ≥1 for subagent turns.

---

## 10. Reserved for later specs

Deliberately out of scope, to be specified in follow-ups:

- **Streaming protocol between backend and UI**: chunk shape,
  back-pressure, mid-stream errors, the exact wire format for
  "rewrite" replacements. Lives in `004_SCHEMAS.md` once the
  schemas are stable.
- **Background-only turns** (cron triggers, schedule triggers): a
  turn with no inbound user message. The same pipeline applies
  with the user-message step replaced by a synthetic system
  trigger; the details (idempotency, surfacing in the UI,
  cost accounting) are their own document.
- **Resume semantics** for partial failures (§6.5). The contract is
  fixed here (a follow-up user submission with metadata pointing at
  the previous turn) but the precise resumption rules — re-stream
  vs. continue, what is replayed to the model — are not.
- **Per-turn quotas and per-user cost ceilings**: when to refuse a
  turn pre-flight because the user has exceeded a budget. The
  hooks (the scope classifier can read a budget, the runner can
  refuse) are in place; the policy is not.
- **Multi-user shared conversations**: today every row carries a
  single `user_id`. Group conversations are a schema and a runner
  change; both are deferred.
- **Critic chaining**: today a turn calls the critic at most once.
  A future spec may allow the critic to chain another critic on
  `escalate`, with a cap.
