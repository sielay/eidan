# 007 — Provider abstraction

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Stack, Agentic loop),
`docs/001_PLUGINS.md` (§1 manifest env/vault, §2.2 PluginContext),
`docs/003_MEMORY_DDL.md` (§9 `llm_calls`),
`docs/004_SCHEMAS.md` (`agentic/*` DTOs, JSON Schema as source of truth),
`docs/005_AGENTIC_LOOP.md` (§5.3 Sizer, §5.5 Primary loop, §6 Error
handling), `docs/006_BEHAVIOURS_TRIGGERS.md` (§6.2 tool surface)

This document specifies the **Python interface every LLM provider
adapter must implement** to be a first-class peer inside Eidan. It
pins down:

- The methods every adapter exposes: chat, stream, structured
  output, token counting, and a model-metadata surface.
- How token accounting (input / output / cache-read / cache-creation)
  maps onto the four columns of `eidan.llm_calls`.
- How prompt caching is expressed uniformly across providers that
  support it natively and those that don't.
- The model-registry shape: size class (haiku- / sonnet- /
  opus-equivalent), context window, capabilities, pricing.
- The auth model: env-var conventions, vault keys, per-agent
  overrides.
- Error normalisation: the typed exception hierarchy every adapter
  raises, and the table that maps each provider's native errors
  into it.
- The five providers shipped in core — Anthropic, OpenAI, Gemini,
  Mistral, and a local provider (Ollama / llama.cpp HTTP) — and the
  per-provider conformance notes each one carries.

The goal is so an upper-layer caller (`005 §5.5`, `006 §6.2`) can
write its loop once against `Provider` and have any of the five
drop in.

Out of scope (deferred to follow-ups, see §12):

- The wire shape of the streaming chunks Eidan emits to its own UI
  — owned by `004_SCHEMAS.md` once the schema is stable.
- Embeddings, image generation, audio. Only chat-style completions
  are in scope for MVP.
- Self-hosted Anthropic-/OpenAI-compatible gateways (LiteLLM,
  OpenRouter, Bedrock, Vertex AI proxy) beyond what the existing
  OpenAI-compatible base handles.
- Adaptive cross-provider routing under cost / latency pressure —
  the data is in `llm_calls`, the policy is not.

---

## 1. Vocabulary

| Term                    | Meaning                                                                                                                                                                  |
|-------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Provider**            | A Python object that adapts one upstream API (Anthropic, OpenAI, …) to the protocol in §2. One provider per upstream, even if it exposes many models.                    |
| **ProviderRegistry**    | The host-owned table that resolves a model string (e.g. `claude-opus-4-7`) to the `Provider` instance that knows how to call it. Singleton per host process.            |
| **Model**               | A specific named completion endpoint on a provider (e.g. `gpt-4o-mini`, `claude-sonnet-4-6`). Identified by `ModelInfo.id`.                                              |
| **Size class**          | One of `small` / `medium` / `large`, the taxonomy the sizer (`005 §5.3`) uses. Each provider declares which class each of its shipped models belongs to.                 |
| **Native caching**      | The provider supports a wire-level mechanism that bills the cache-read portion of a prompt at a lower rate (Anthropic `cache_control`, OpenAI automatic prefix cache, Gemini `cachedContents`). |
| **Pass-through caching**| The provider does not support native caching. The adapter accepts the same call shape, ignores the cache hints, and reports `cache_read_tokens = cache_creation_tokens = 0`. |
| **ProviderCall**        | The handle yielded by `Provider.start_call(...)`. Owns the in-flight stream, the eventual assembled assistant turn, and the accounting fields.                            |
| **AssistantTurn**       | The normalised final shape of one round-trip's assistant output: `content` (text), `tool_calls`, optional `structured`, plus accounting. The shape `Message` in `eidan.messages` is built from this. |
| **NormalisedError**     | One of the typed exceptions in §8.1. Every provider error funnels through this hierarchy before reaching the runner.                                                       |

---

## 2. The Provider protocol

The interface is a Python **`Protocol`** (PEP 544), not an abstract
base class. Reasons:

- Adapters live both in the host's tree and in plugins
  (`001_PLUGINS.md §1`). Forcing inheritance from a concrete base
  couples plugin authors to a host import path; a structural
  protocol does not.
- The runner type-checks against `Provider`, but the registry
  registers instances by capability surface, not by class. A
  `Protocol` makes this assignment trivial.
- Plugins can wrap an existing provider (a logging proxy, a
  cost-budget shim) without subclassing the base.

### 2.1 The shape

```python
# eidan/providers/protocol.py
from __future__ import annotations
from typing import AsyncContextManager, AsyncIterator, Protocol, Sequence
from collections.abc import Mapping

from .messages   import Message, ToolDef, AssistantTurn, StreamEvent
from .info       import ProviderInfo, ModelInfo, Capability
from .accounting import CacheHints, CallAccounting, TokenEstimate
from .errors     import ProviderError  # see §8


class Provider(Protocol):
    """The contract every LLM adapter satisfies.

    Adapters MUST be safe to call from multiple coroutines on the
    same instance: they own the upstream HTTP client and reuse a
    keep-alive connection pool internally.
    """

    @property
    def name(self) -> str:
        """Stable identifier: 'anthropic', 'openai', 'gemini',
        'mistral', 'ollama', 'llamacpp'. Matches the env-var
        prefix in §7."""

    def info(self) -> ProviderInfo:
        """Static metadata: models shipped, capabilities, pricing."""

    def supports(self, model: str, capability: Capability) -> bool:
        """O(1) check before calling. Capability values listed in §6.3."""

    async def count_input_tokens(
        self,
        *,
        model: str,
        system: str | None,
        messages: Sequence[Message],
        tools: Sequence[ToolDef] = (),
    ) -> TokenEstimate:
        """Best-effort upper-bound token count, used by the sizer
        (`005 §5.3`) and by the compaction trigger in the primary
        loop (`005 §5.5`)."""

    def start_call(
        self,
        *,
        role: str,                          # `llm_calls.role`, 003 §9
        model: str,
        system: str | None,
        messages: Sequence[Message],
        tools: Sequence[ToolDef] = (),
        tool_choice: str | None = None,     # "auto" | "required" | tool name
        stream: bool = True,
        response_format: dict | None = None,  # JSON Schema, §3.3
        cache: CacheHints | None = None,      # §5
        request_id: str,
        extra: Mapping[str, object] | None = None,  # provider-specific
    ) -> AsyncContextManager["ProviderCall"]:
        """Open one round-trip. Returns a context manager whose
        body yields the in-flight call handle."""


class ProviderCall(Protocol):
    """The handle yielded by `Provider.start_call(...)`."""

    async def stream(self)  -> AsyncIterator[StreamEvent]: ...
    async def collect(self) -> AssistantTurn:              ...
    def     accounting(self) -> CallAccounting:            ...
```

`StreamEvent` is the normalised discriminated union of
`content_delta`, `tool_use_start`, `tool_use_delta`,
`tool_use_stop`, `structured_delta`, and `message_stop`. The
externally visible wire shape (what the UI receives) is owned by
`004_SCHEMAS.md`; the *internal* event shape is the protocol's,
and is concretely a dataclass union.

### 2.2 Why a context manager

`start_call` returns an `AsyncContextManager` rather than a plain
coroutine because:

- The upstream connection must be closed deterministically. A
  cancelled task (`005 §6.2` per-turn deadline) needs the
  adapter's `__aexit__` to abort the stream cleanly.
- Token-accounting fields are only complete after the stream
  finishes. The context manager guarantees `accounting()` is
  read inside the `async with`, where the call object's lifetime
  makes that safe.

```python
async with provider.start_call(...) as call:
    async for ev in call.stream():
        await ctx.emit_to_ui(ev)
    final = await call.collect()
    book  = call.accounting()
```

`collect()` is allowed after the stream has been consumed; it
returns the same final blocks the stream produced, assembled. The
runner uses one or the other, not both — the spec does not
promise efficient re-assembly.

### 2.3 What the protocol deliberately omits

- **No retry loop.** Retries live in the runner (`005 §6.4`), not
  in adapters; one provider call equals one HTTP attempt equals
  one `llm_calls` row.
- **No prompt assembly.** The runner builds `system`, `messages`,
  and `tools` (`005 §5.4`, `006 §6.1`). The adapter formats them
  for the upstream wire.
- **No model-policy decisions.** The sizer (`005 §5.3`) picks the
  model string; the adapter routes by it but never overrides it.
- **No persistence.** `eidan.messages` and `eidan.llm_calls` are
  owned by the runner; the adapter returns the data the runner
  writes.

This is the boundary that makes the abstraction composable: an
adapter is a participant in the agentic loop, not a redefinition
of one.

---

## 3. Chat, stream, structured output

Three call shapes, one entry point. All three go through
`start_call`; differences are in the arguments.

### 3.1 Streaming (default)

`stream=True` (the default). The runner consumes the iterator,
forwards `content_delta` chunks to the UI, and accumulates
`tool_use` blocks for the loop in `005 §5.5`. Streaming is the
unconditional default in the design — even non-user-facing roles
(scope, sizer, behaviour classifier) stream, because the latency
win on the first content token matters for ergonomic dev tooling
and because keeping one path simplifies the runner.

A provider that does not support streaming natively (rare; only
some local servers in certain modes) emulates it: the adapter
issues the upstream call non-streamed, then yields a single
`content_delta` carrying the full result followed by
`message_stop`. The runner's code path stays uniform.

### 3.2 Non-streaming `chat`

There is no separate `chat()` method on the protocol. Callers that
want the final shape directly:

```python
async with provider.start_call(..., stream=False) as call:
    final = await call.collect()
```

`stream=False` is a hint to the adapter to skip emitting per-token
events; the adapter MAY still stream upstream and assemble. The
contract is only that `call.stream()` yields exactly one composite
event (the full assistant turn) before `message_stop`.

### 3.3 Structured output

When `response_format` is set to a JSON Schema (the same artefact
that drives codegen, `004_SCHEMAS.md §1`), the provider:

1. Constrains the model's output to validate against that schema.
2. Returns the parsed object on `AssistantTurn.structured` — *and*
   in `content` as the JSON-encoded string, for callers that want
   the raw text.
3. Reports schema-violation failures as `ProviderBadOutputError`
   (§8.1), not as silent best-effort.

Per-provider implementation:

| Provider       | Mechanism                                                                                                                        |
|----------------|-----------------------------------------------------------------------------------------------------------------------------------|
| Anthropic      | `tools=[{name: "respond", input_schema: <schema>}]` with `tool_choice = {type: "tool", name: "respond"}`. The adapter strips the tool wrapping before returning. |
| OpenAI         | `response_format = {type: "json_schema", json_schema: {schema, strict: true}}`.                                                  |
| Gemini         | `generationConfig.responseSchema = <schema>` with `responseMimeType = "application/json"`.                                       |
| Mistral        | `response_format = {type: "json_schema", schema: <schema>}` on `mistral-large`; tool-call fallback for older models.             |
| Ollama         | `format = <schema>` (JSON-schema mode in recent builds).                                                                          |
| llama.cpp HTTP | `response_format` on the OpenAI-compatible endpoint, or `json_schema` on the native `/completion` endpoint.                       |

A model that does not advertise `supports(model, "structured_output")`
raises `ProviderCapabilityError` at `start_call` time rather than
producing un-validated JSON. The runner picks a different model
rather than trying to parse free-form text.

### 3.4 Tool calls

The `tools` argument carries `ToolDef` objects whose `input_schema`
field is a JSON Schema (the same `$id`-bearing schemas from
`004_SCHEMAS.md`). The adapter translates the list into the
upstream tools payload:

| Provider       | Tools payload                                                                       |
|----------------|--------------------------------------------------------------------------------------|
| Anthropic      | `tools[]` with `name`, `description`, `input_schema`.                                |
| OpenAI         | `tools[]` with `type: "function"`, `function: {name, description, parameters}`.      |
| Gemini         | `tools = [{functionDeclarations: [{name, description, parameters}]}]`.               |
| Mistral        | `tools[]` matching OpenAI's shape.                                                   |
| Ollama         | `tools[]` matching OpenAI's shape on `/api/chat`.                                    |
| llama.cpp HTTP | Via the OpenAI-compatible endpoint only. Native `/completion` does not surface tool calls. |

Tool calls come back as `StreamEvent.tool_use_*` events and are
assembled into `AssistantTurn.tool_calls`. **Per-tool argument
validation is the adapter's job** — it parses the model's emitted
arguments against `input_schema` and raises
`ProviderBadOutputError` on mismatch. This concentrates one
recurring failure mode in one place rather than spreading it
across every tool handler.

---

## 4. Token counting and accounting

### 4.1 The four columns

`eidan.llm_calls` exposes four token counts (`003 §9`):
`input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_creation_tokens`. The shape is Anthropic's — chosen because
it is the strictest superset. Every other provider's reporting
flattens into one of the four with zeroes for the rest.

The adapter populates them as follows:

| Provider       | input                                                              | output                                  | cache_read                                              | cache_creation                                                   |
|----------------|---------------------------------------------------------------------|------------------------------------------|----------------------------------------------------------|-------------------------------------------------------------------|
| Anthropic      | `usage.input_tokens`                                                | `usage.output_tokens`                    | `usage.cache_read_input_tokens`                          | `usage.cache_creation_input_tokens`                              |
| OpenAI         | `usage.prompt_tokens − usage.prompt_tokens_details.cached_tokens`   | `usage.completion_tokens`                | `usage.prompt_tokens_details.cached_tokens`              | `0` (OpenAI's caching is automatic; no creation row)             |
| Gemini         | `usageMetadata.promptTokenCount − cachedContentTokenCount`          | `usageMetadata.candidatesTokenCount`     | `usageMetadata.cachedContentTokenCount`                  | `0` (Gemini's cache is created out of band via `cachedContents`) |
| Mistral        | `usage.prompt_tokens`                                               | `usage.completion_tokens`                | `0`                                                      | `0`                                                                |
| Ollama         | `prompt_eval_count`                                                 | `eval_count`                             | `0`                                                      | `0`                                                                |
| llama.cpp HTTP | `tokens_evaluated`                                                  | `tokens_predicted`                       | `0`                                                      | `0`                                                                |

The arithmetic — subtracting cached tokens from the headline input
count, so the four counters are disjoint — is the adapter's, not
the runner's. The runner sees four already-disjoint columns and
multiplies each by the relevant rate from the price table
(`§6.4`).

### 4.2 `count_input_tokens` before the call

The sizer (`005 §5.3`) and the compaction threshold (`005 §5.5`)
both need an *a priori* estimate of input tokens.
`Provider.count_input_tokens` is the entry point.

| Provider       | Implementation                                                                                                       |
|----------------|-----------------------------------------------------------------------------------------------------------------------|
| Anthropic      | `POST /v1/messages/count_tokens` (free, billed at zero). Network call, async.                                        |
| OpenAI         | `tiktoken` against the encoder the requested model uses. No network.                                                  |
| Gemini         | `POST :countTokens`. Free, billed at zero.                                                                            |
| Mistral        | The adapter ships the official Mistral tokeniser blob; no network.                                                    |
| Ollama         | Local `/api/tokenize` endpoint when the running model is loaded; otherwise the heuristic in §4.3.                     |
| llama.cpp HTTP | `/tokenize` endpoint. No network beyond the local host.                                                                |

A provider whose `count_input_tokens` requires a network call
(Anthropic, Gemini) MAY cache results keyed on the hash of
`(system, messages, tools)` for a short TTL (default 30 s).
Cache hits do not generate an `llm_calls` row because they are not
provider calls in the accounting sense.

The returned `TokenEstimate` carries `value: int` and
`accuracy: "exact" | "heuristic"` so the sizer knows when to widen
its budget (see §4.3).

### 4.3 The heuristic fallback

When a per-provider tokeniser is unavailable (a brand-new model on
Ollama, an experimental endpoint), the adapter returns
`len(serialised_prompt) // 4` with `accuracy="heuristic"`. The
sizer (`005 §5.3`) reads the flag and widens its budget for
heuristic estimates. The runner does *not* refuse to call the
provider just because the estimate is heuristic; it just accounts
for the worse signal.

### 4.4 Output tokens

Output tokens are observed, not predicted. The adapter MUST
surface them via `accounting()` after the stream completes. If the
upstream truncated a response (max-tokens, content-policy,
network drop, finite local KV slot), the adapter sets
`output_tokens` to whatever was actually emitted and records the
truncation in `accounting().truncated_reason`. The runner reads
that field on the path from `005 §5.5` to `005 §6.3`.

---

## 5. Prompt caching

Two providers (Anthropic, Gemini) require the adapter to mark
which parts of the prompt to cache. One (OpenAI) caches
automatically once a prefix crosses a length threshold. The rest
(Mistral, Ollama, llama.cpp) do not cache at all. The protocol
surfaces a single shape that all six adapt to.

### 5.1 The `CacheHints` shape

```python
@dataclass(frozen=True, slots=True)
class CacheHints:
    """Where the runner would like cache anchors placed.

    Adapters that support native caching translate these into the
    upstream cache mechanism. Adapters that do not support caching
    ignore the hints and report zeros in §4.1's `cache_read` /
    `cache_creation` columns. The runner treats both behaviours
    as conforming.
    """
    system:        bool       = True   # cache the system prompt
    tools:         bool       = True   # cache the tools[] array
    history_until: int | None = None
    # If set, cache the first `history_until` messages of `messages`
    # (typically everything except the last user turn).
```

The runner sets all three when the prompt has a stable prefix.
`006 §6.1` deliberately makes the system-prompt section
shape-stable across turns for exactly this reason — cache hits
across consecutive turns of a conversation are the dominant cost
win.

### 5.2 Per-provider translation

| Provider       | Behaviour                                                                                                                                                         |
|----------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Anthropic      | Adapter appends `cache_control = {type: "ephemeral"}` to the last content block of each requested cache region. Up to 4 cache anchors per request; the adapter folds `system + tools + history_until` to fit. |
| OpenAI         | OpenAI auto-caches any prompt prefix above 1024 tokens. The adapter sets `prompt_cache_key = f"{agent_id}:{role}"` to opt into prefix-stable routing; the hint fields are otherwise no-ops. |
| Gemini         | Native caching requires creating a `cachedContent` resource first (§5.4). On a cache miss the adapter falls back to non-cached calls until the resource is created. |
| Mistral        | Pass-through. `CacheHints` is ignored. `cache_read = cache_creation = 0` in every row.                                                                              |
| Ollama         | Pass-through. Some local stacks reuse the KV cache across calls but the reuse is not billed and not reported.                                                       |
| llama.cpp HTTP | Pass-through. The `slot_id` parameter enables KV-cache reuse on the server side but is opaque to billing.                                                           |

### 5.3 Reporting

`accounting().cache_read_tokens` and
`accounting().cache_creation_tokens` are the only externally
observable signals that caching worked. The runner's per-turn cost
rollup (`005 §9`) prices these columns at the provider's reduced
cache-read rate and the (often slightly inflated) cache-creation
rate, taken from `ProviderInfo.pricing` (§6.4).

A turn that asks for caching and receives `cache_read = 0` for
several calls is a smell, not a bug — the operator's dashboard
surfaces a "low cache hit rate" warning derived directly from
`eidan.llm_calls`. No special metric infrastructure is needed.

### 5.4 Out-of-band cache preparation (Gemini specific)

Gemini's cache resources are created via a separate API call
(`cachedContents.create`) and referenced by resource name. The
Gemini adapter exposes:

```python
class GeminiProvider:
    async def prepare_cache(
        self,
        *,
        model:           str,
        system:          str | None,
        tools:           Sequence[ToolDef],
        history_prefix:  Sequence[Message],
        ttl_seconds:     int = 3600,
    ) -> str:  # returns the cachedContent resource name
```

The runner is allowed to call `prepare_cache` once and reuse the
returned name across many `start_call`s in the same conversation.
This is an extra method that lives **outside** the core `Provider`
protocol; callers feature-detect with
`hasattr(provider, "prepare_cache")`. It is the only sanctioned
provider-specific extension; the rest of the surface is uniform.

---

## 6. Model metadata

The registry is the source of truth for which models the host can
call, what size class each maps to, what its context window is,
and what each token costs.

### 6.1 `ModelInfo`

```python
@dataclass(frozen=True, slots=True)
class ModelInfo:
    id:                str                  # the model string passed
                                            # to start_call
    provider:          str                  # ProviderInfo.name
    size_class:        SizeClass            # see §6.2
    context_window:    int                  # tokens
    max_output_tokens: int                  # provider-imposed cap
    capabilities:      frozenset[Capability]
    pricing:           Pricing              # USD/Mtok, four-row
    aliases:           tuple[str, ...] = ()
    # Alternative ids the registry resolves to this entry — e.g.
    # "claude-3-5-sonnet" → "claude-sonnet-4-6" pre-rename.
    deprecated_at:     str | None = None    # ISO date; warn on use
```

### 6.2 Size class

```python
class SizeClass(str, Enum):
    SMALL  = "small"   # haiku-class:  classifiers, sizers, routers
    MEDIUM = "medium"  # sonnet-class: default substantive answers
    LARGE  = "large"   # opus-class:   deep reasoning, escalations
```

The mapping is **declared by the provider**, not inferred. The
sizer (`005 §5.3`) selects a size class; the registry picks the
cheapest model of that class on the configured default provider.
The agent's `agent_context.user_overrides` (`003 §7`) MAY pin a
specific `ModelInfo.id`; that overrides the size-class selection.

Ground-truth mappings shipped in core (May 2026, see CHANGELOG for
updates):

| size   | Anthropic              | OpenAI            | Gemini             | Mistral                 | Ollama / llama.cpp    |
|--------|------------------------|-------------------|--------------------|--------------------------|-----------------------|
| small  | `claude-haiku-4-5`     | `gpt-4o-mini`     | `gemini-2.5-flash` | `mistral-small-latest`   | operator-tagged       |
| medium | `claude-sonnet-4-6`    | `gpt-4o`          | `gemini-2.5-pro`   | `mistral-medium-latest`  | operator-tagged       |
| large  | `claude-opus-4-7`      | operator-chosen   | `gemini-2.5-ultra` | `mistral-large-latest`   | operator-tagged       |

The local provider has no inherent size class; operators tag their
loaded models in config (§7.4). A `small`-tagged local model is
treated as small by the sizer even if it is, in practice, a 70B
parameter quant — that is the operator's choice, not the sizer's.

The "operator-chosen" cell for OpenAI's large slot reflects that
OpenAI ships several large-class models with very different
trade-offs (reasoning depth, latency, price). The host config
names one; there is no default, because picking it for the
operator is a policy decision Eidan declines to make.

### 6.3 Capabilities

A capability is a string the host feature-detects on. The set is
closed:

| Capability             | Meaning                                                                  |
|------------------------|---------------------------------------------------------------------------|
| `stream`               | Supports server-sent streaming on the wire.                              |
| `tools`                | Supports the tools / function-calling interface in §3.4.                 |
| `structured_output`    | Supports the structured-output mode in §3.3.                             |
| `vision`               | Accepts image content blocks.                                             |
| `cache_native`         | Caching is billed at a reduced rate (§5).                                |
| `tool_choice_required` | Supports forcing a specific tool by name.                                 |
| `parallel_tool_use`    | The model can emit multiple tool calls in one turn.                       |
| `long_context`         | Context window ≥ 200k tokens.                                             |

The runner checks capabilities at `start_call` build time. A
request for `tools` against a model whose `ModelInfo.capabilities`
lacks it raises `ProviderCapabilityError` **before** any HTTP
call. This makes a misconfiguration visible at the boundary, not
at three different broken-response sites downstream.

### 6.4 Pricing

```python
@dataclass(frozen=True, slots=True)
class Pricing:
    input_per_mtok:           float
    output_per_mtok:          float
    cache_read_per_mtok:      float
    cache_creation_per_mtok:  float
    currency:                 str = "USD"
    effective_from:           str | None = None   # ISO date
```

Pricing is stored on `ModelInfo`, not on `ProviderInfo`. A
provider may ship many models with very different prices, and a
price change is a `ModelInfo` edit, not a re-registration.

Historical reporting is unaffected by price changes because
`eidan.llm_calls.cost_usd` is **computed at call time and
stored** (`003 §9`); the price table is consulted once per row,
never on read.

---

## 7. Authentication and configuration

### 7.1 Env-var conventions

Every provider declares the env vars it reads in the host's plugin
manifest fragment (the host bundles each of its built-in providers
under a thin pseudo-plugin so the `env:` / `vault:` declarations
in `001_PLUGINS.md §1.1` apply uniformly).

| Provider   | Required                                    | Optional                                |
|------------|---------------------------------------------|------------------------------------------|
| Anthropic  | `ANTHROPIC_API_KEY`                         | `ANTHROPIC_BASE_URL`                     |
| OpenAI     | `OPENAI_API_KEY`                            | `OPENAI_BASE_URL`, `OPENAI_ORG_ID`       |
| Gemini     | `GEMINI_API_KEY` *(preferred)* **or** `GOOGLE_API_KEY` *(fallback)* | `GEMINI_BASE_URL`        |
| Mistral    | `MISTRAL_API_KEY`                           | `MISTRAL_BASE_URL`                       |
| Ollama     | —                                           | `OLLAMA_BASE_URL` (default `http://localhost:11434`) |
| llama.cpp  | —                                           | `LLAMACPP_BASE_URL` (default `http://localhost:8080`) |

The required env vars are checked at host startup. A missing
required key disables the provider; the host logs the deficiency
and continues. A host with only Anthropic configured is still
useful, even though `gpt-4o-mini` won't route — the sizer's
fallback table reads the registry's enabled-provider set and
won't return a model whose adapter is disabled.

### 7.2 Vault keys

Operators MAY put the same secret in the vault instead of an env
var, under `provider.<name>.api_key`. Resolution order at adapter
init:

1. The per-agent override
   (`agent_context.user_overrides.provider.<name>.api_key`).
2. The vault entry (`provider.<name>.api_key`) — host-wide.
3. The env var.

The first non-empty value wins. A turn whose agent points at a
different key than the host's default routes through the same
adapter instance with a per-call header override; the adapter does
**not** keep one client per (user, agent) tuple, because that
would explode the connection pool with no upside.

### 7.3 Per-agent provider override

`agent_context` (`003 §7`) carries an optional
`provider_preference` field:

```jsonc
{
  "provider_preference": {
    "primary":    { "provider": "anthropic", "model": "claude-opus-4-7" },
    "scope":      { "provider": "openai",    "model": "gpt-4o-mini"     },
    "summariser": { "provider": "gemini",    "model": "gemini-2.5-flash"}
  }
}
```

The runner reads this when assembling each role's call; the
sizer's output may be overridden role-by-role. Unset roles fall
through to the host default for the matching size class.

### 7.4 Local provider configuration

Ollama and llama.cpp HTTP do not ship their own model list; the
operator writes one to
`~/.config/eidan/providers/local.yaml`:

```yaml
ollama:
  base_url: http://localhost:11434
  models:
    - id: llama3.1:8b
      size_class: small
      context_window: 131072
      max_output_tokens: 4096
      capabilities: [stream, tools]
    - id: llama3.1:70b-instruct-q4_K_M
      size_class: large
      context_window: 131072
      max_output_tokens: 4096
      capabilities: [stream, tools]
      pricing:
        input_per_mtok:  0.0
        output_per_mtok: 0.0
```

The local provider reads this file at host start and registers
one `ModelInfo` per entry. The structure is part of the local
provider's own JSON Schema under
`packages/schemas/schemas/core/providers/LocalProviderConfig.schema.json`
and goes through codegen like any other DTO
(`004_SCHEMAS.md`). Pricing defaults to zero, which the operator
may override for self-cost accounting on hosted hardware.

---

## 8. Error normalisation

### 8.1 The exception hierarchy

```python
# eidan/providers/errors.py

class ProviderError(Exception):
    """Base. Every provider failure inherits from this."""
    retryable:    bool
    request_id:   str | None
    retry_after:  float | None   # seconds; populated on RateLimit / Overloaded


class ProviderTransientError(ProviderError):     retryable = True   # network
class Provider5xxError(ProviderError):            retryable = True
class ProviderRateLimitError(ProviderError):      retryable = True
class ProviderOverloadedError(ProviderError):     retryable = True

class ProviderBadRequestError(ProviderError):     retryable = False  # bug
class ProviderAuthError(ProviderError):           retryable = False  # config
class ProviderNotFoundError(ProviderError):       retryable = False  # config
class ProviderContentPolicyError(ProviderError):  retryable = False
class ProviderContextOverflowError(ProviderError):                   # → compaction
    retryable = False
class ProviderCapabilityError(ProviderError):     retryable = False
class ProviderBadOutputError(ProviderError):      retryable = False  # schema fail
```

Every typed exception carries:

- `request_id` — the upstream's request id when surfaced, else
  `None`. Lands in `eidan.llm_calls.request_id` and in the
  user-facing error envelope (`005 §6.5`).
- `retry_after` — populated on `ProviderRateLimitError` and
  `ProviderOverloadedError` whenever the upstream sends a hint;
  consulted by `005 §6.1`'s backoff routine.

The hierarchy intentionally mirrors the table in `005 §6.1`. Each
runner-side decision in `005 §6.4` consults `e.retryable` and
`type(e).__name__`; the adapter's job is to make sure both are
correct.

### 8.2 The normalisation table

| Provider       | Native shape                                      | Normalised to                                                                |
|----------------|----------------------------------------------------|------------------------------------------------------------------------------|
| Anthropic      | `429 rate_limit_error`                             | `ProviderRateLimitError`                                                     |
|                | `529 overloaded_error`                             | `ProviderOverloadedError`                                                    |
|                | `400 invalid_request_error`                        | `ProviderBadRequestError`                                                    |
|                | `401 authentication_error`                         | `ProviderAuthError`                                                          |
|                | `403 permission_error`                             | `ProviderAuthError`                                                          |
|                | `404 not_found_error`                              | `ProviderNotFoundError`                                                      |
|                | `400` w/ `prompt is too long`                      | `ProviderContextOverflowError`                                               |
| OpenAI         | `429 rate_limit_exceeded`                          | `ProviderRateLimitError`                                                     |
|                | `429 insufficient_quota`                           | `ProviderAuthError` (not retryable; config)                                   |
|                | `503 server_overloaded`                            | `ProviderOverloadedError`                                                    |
|                | `400 context_length_exceeded`                      | `ProviderContextOverflowError`                                               |
|                | `400 invalid_request_error`                        | `ProviderBadRequestError`                                                    |
|                | `401`                                              | `ProviderAuthError`                                                          |
|                | content filter / moderation block                  | `ProviderContentPolicyError`                                                 |
| Gemini         | `429 RESOURCE_EXHAUSTED`                           | `ProviderRateLimitError`                                                     |
|                | `503 UNAVAILABLE`                                  | `Provider5xxError`                                                           |
|                | `400 INVALID_ARGUMENT`                             | `ProviderBadRequestError`                                                    |
|                | `403 PERMISSION_DENIED`                            | `ProviderAuthError`                                                          |
|                | `safetyRatings.blocked`                            | `ProviderContentPolicyError`                                                 |
|                | `finishReason = MAX_TOKENS`                        | *not* an error; reported as truncation (§4.4)                                |
| Mistral        | `429`                                              | `ProviderRateLimitError`                                                     |
|                | `400`                                              | `ProviderBadRequestError`                                                    |
|                | `401`                                              | `ProviderAuthError`                                                          |
|                | `5xx`                                              | `Provider5xxError`                                                           |
| Ollama         | connection refused                                 | `ProviderTransientError`                                                     |
|                | `404 model not found`                              | `ProviderNotFoundError`                                                      |
|                | `500` w/ OOM                                       | `Provider5xxError` (retryable; runner's bounded retries cap the blast)        |
| llama.cpp HTTP | connection refused                                 | `ProviderTransientError`                                                     |
|                | `400 slot unavailable`                             | `ProviderOverloadedError`                                                    |
|                | other `5xx`                                        | `Provider5xxError`                                                           |

The adapter **never** raises a provider-native exception type to
the runner. If a new provider error shape appears that doesn't fit
the table, the adapter wraps it in the most conservative typed
class (`Provider5xxError` if it looks retryable,
`ProviderBadRequestError` otherwise) and logs the unrecognised
payload. Adding rows to the table is a follow-up PR; failing
closed to the table is the default.

### 8.3 Error rows in `llm_calls`

Every failed call still writes a row (`005 §6.5`):

| column          | value on error                                          |
|-----------------|----------------------------------------------------------|
| `error`         | the human-readable message (truncated to ~2 KB)          |
| `error_type`    | the typed class name, e.g. `ProviderRateLimitError`      |
| `output_tokens` | `0` unless a stream had begun                            |
| `input_tokens`  | the count as reported by the failure, if any, else `0`   |
| `latency_ms`    | time-to-failure                                           |
| `cost_usd`      | computed from whatever tokens did flow                    |

This makes the per-user cost dashboard (`005 §9`) attribute even
failed calls to the user that incurred them — important for noisy
quota debugging.

---

## 9. Per-provider notes

Each adapter has small implementation specifics worth pinning so
the next person to touch one doesn't re-derive them.

### 9.1 Anthropic

- Wire: `POST /v1/messages`. Streaming via SSE.
- The official Python SDK (`anthropic`) is the adapter's
  transport.
- Cache anchors: up to 4 per request. The adapter folds
  `CacheHints.system + tools + history_until` into the first 4
  cache-eligible blocks; if the runner asks for more, the
  history-prefix anchor is dropped first.
- `count_input_tokens` uses `POST /v1/messages/count_tokens`
  (free).
- Pricing source: the model registry's `ModelInfo.pricing` mirrors
  Anthropic's published price list; updates ship as a `Pricing`
  patch when Anthropic posts a change.

### 9.2 OpenAI

- Wire: `POST /v1/chat/completions`. Streaming via SSE.
- The official Python SDK (`openai`) is the adapter's transport.
- `prompt_cache_key` is set to `f"{agent_id}:{role}"` to keep the
  prefix cache routed consistently. The adapter never sets the
  user-visible `user` field; OpenAI's training-data toggle is the
  operator's responsibility via the org-level dashboard.
- `count_input_tokens` uses `tiktoken` locally.
- Reasoning models (`o`-series) emit `reasoning_tokens` in their
  usage shape. The adapter folds these into `output_tokens` and
  records the breakdown on `accounting().metadata.reasoning_tokens`
  so the four-column ledger stays clean while the audit trail is
  preserved.

### 9.3 Gemini

- Wire: `POST .../models/<id>:streamGenerateContent`.
- The Python SDK (`google-genai`) is the adapter's transport.
- Native caching is opt-in via `cachedContents` (§5.4). The
  default for one-off calls is no cache.
- Safety: the adapter does NOT downgrade safety thresholds. A
  blocked turn raises `ProviderContentPolicyError`; the runner
  surfaces it (`005 §6.5`) and the operator decides whether to
  retry under a different agent.
- `finishReason = MAX_TOKENS` becomes
  `accounting().truncated_reason = "max_tokens"`, not an exception.

### 9.4 Mistral

- Wire: OpenAI-compatible `POST /v1/chat/completions` at
  `https://api.mistral.ai`.
- Adapter shares ~80% of its code with the OpenAI adapter via a
  small internal `OpenAICompatibleAdapter` base. Both providers
  register their own `Provider` instance; the shared base is
  private to the host.
- No native caching, no reasoning-tokens shape, no vision on the
  small models.

### 9.5 Local: Ollama

- Wire: `POST /api/chat`, streaming via newline-delimited JSON.
- Discovery: `GET /api/tags` lists loaded models, cross-checked
  against `local.yaml` (§7.4). A model in the config that isn't
  loaded surfaces as `ProviderNotFoundError` on first call; the
  operator decides whether to `ollama pull`.
- Tool calls: supported on recent versions, signalled by
  `message.tool_calls[]` in the response. Older versions surface
  tools as JSON in `content` and would require the adapter to
  parse them out heuristically; the adapter refuses
  (`ProviderCapabilityError`) rather than guess.
- `count_input_tokens` uses `/api/tokenize` when the model is
  loaded, else falls back to the heuristic in §4.3.

### 9.6 Local: llama.cpp HTTP

- Wire: `POST /v1/chat/completions` (the OpenAI-compatible
  endpoint exposed by `llama-server`).
- The native `/completion` endpoint is **not** used by this
  adapter; it cannot emit tool calls in a normalised shape and
  its usage payload is different. An operator who wants the
  native endpoint writes a plugin-vended provider.
- Concurrency: `llama-server` serves one slot at a time by
  default. The adapter does not impose its own queue; a busy
  slot surfaces as `ProviderOverloadedError` and the runner's
  retry policy (`005 §6.4`) decides.

---

## 10. Selection: how the runner picks a Provider

`005 §5.3` says the sizer returns a `model` string and a
`provider` is implied by it. This section pins down the lookup.

### 10.1 The flow

```
sizer → SizerResult(model="claude-opus-4-7", ...)
   │
   ▼
ProviderRegistry.resolve("claude-opus-4-7")
   │   1. exact match on ModelInfo.id        → that provider
   │   2. exact match on ModelInfo.aliases   → that provider
   │   3. miss                                → ProviderNotFoundError
   ▼
Provider instance
   │
   ▼
provider.start_call(role="primary", model="claude-opus-4-7", ...)
```

### 10.2 Why the sizer emits a model, not (provider, size_class)

Two reasons:

- The per-agent override (`§7.3`) is expressed in
  `(provider, model)` terms because *that's how operators reason*.
  The sizer's job is to honour the override, which means it
  produces the final model name.
- A future routing layer that wants to switch providers under
  cost / latency pressure operates on the sizer's output. Pinning
  the contract at "the sizer names the model" leaves room for an
  adaptive layer without changing the protocol.

### 10.3 Fallback when the chosen model is unavailable

If the registry has the model but the underlying adapter was
disabled at startup (missing required env var, repeated 401 on
liveness probe), the registry exposes the model as
`disabled = true`. `resolve` raises
`ProviderNotFoundError("model disabled: missing ANTHROPIC_API_KEY")`
so the sizer can fall back. The sizer's prompt knows about the
registry's enabled set and will not normally propose a disabled
model; this path is the safety net for an operator who pulls
credentials mid-flight.

The sizer's retry policy (`005 §6.4`) caps this at one fallback
before failing the step.

### 10.4 Registry mutation

Adapters are registered at host start and at plugin activation
(`001_PLUGINS.md §8.2`). A plugin MAY register an additional
provider (the OpenRouter case noted in §12) by calling
`ctx.register_provider(...)` on its `PluginContext`. The
`register_provider` call is symmetric to `register_behaviours`
(`006 §4.1`) and follows the same lifecycle:

- Registration is synchronous: the registry is populated before
  `on_activate` returns.
- A `name` collision with an existing provider is a fatal
  `ProviderNameConflict`.
- Deactivation `unregister_provider`s atomically; any turn
  already in flight keeps its provider reference (the registry's
  in-flight handles are reference-counted, not invalidated).

---

## 11. Conformance and testing

### 11.1 The golden conformance suite

Every adapter ships with a fixed conformance suite under
`tests/providers/<name>/`. The suite has one test per row in this
matrix:

| Test                                   | Asserts                                                                                                       |
|----------------------------------------|----------------------------------------------------------------------------------------------------------------|
| `test_chat_text_only`                  | A trivial text-in / text-out call returns content; accounting is non-zero.                                     |
| `test_stream_basic`                    | The event stream yields ≥ 1 `content_delta` then `message_stop`.                                              |
| `test_tool_use_round_trip`             | A tools call returns a `tool_use` block whose `input` validates against the schema, and a tool result is accepted on the next turn. |
| `test_structured_output`               | A `response_format` call returns parsed JSON matching the schema; `AssistantTurn.structured` is populated.    |
| `test_count_input_tokens`              | Estimates within ±10 % of the actual `input_tokens` reported on a real call (relaxed to ±25 % for heuristic). |
| `test_cache_hint_passthrough`          | A cache-hinted call returns either `cache_read > 0` (native) or `cache_read = 0` (pass-through); no exceptions. |
| `test_error_rate_limit_normalises`     | A simulated 429 surfaces as `ProviderRateLimitError` with `retry_after` set.                                  |
| `test_error_auth_normalises`           | A simulated 401 surfaces as `ProviderAuthError`, not retryable.                                                |
| `test_error_context_overflow_normalises` | An oversized prompt surfaces as `ProviderContextOverflowError`.                                              |

The error tests use a recorded fixture
(`tests/providers/<name>/fixtures/*.json`), not a live call. The
non-error tests are recorded with a `RECORD=1 pytest …` mode that
hits the live upstream once and persists the response; subsequent
runs replay from the recording. Recordings are committed and
reviewed alongside code.

The conformance suite **is** the contract — a PR that adds a new
provider runs through the same set, and a PR that changes the
protocol updates the suite in lock-step.

### 11.2 Cross-provider integration test

One non-recorded test runs the same minimal turn (`"say hi"`)
against every enabled provider and asserts:

- A `messages` row is appended.
- An `llm_calls` row carries non-zero `input_tokens`, non-zero
  `output_tokens`, and `error_type IS NULL`.
- Latency is within an operator-configurable budget (default 30 s).

This runs in CI only when at least one provider's credentials are
configured for the CI environment; locally it skips silently when
none are.

### 11.3 Observability hooks

Every adapter emits the same structured log fields per call:

- `provider.name`, `provider.model`, `provider.role`.
- `request_id` (upstream).
- `attempt` — set by the runner (1 for first try, ≥2 after
  retries). The adapter writes a separate
  `attempt_in_adapter` if it performs any internal retries
  on a single HTTP request.
- `cache.read_tokens`, `cache.creation_tokens`.
- `error.type` on failure.

The field names match the column names in `eidan.llm_calls`
exactly, so the log-to-DB correlation key is `request_id` and
nothing else.

---

## 12. Reserved for later specs

Deliberately out of scope, deferred:

- **Embeddings.** The protocol is shaped for chat completions
  only. An `EmbeddingsProvider` peer protocol will live alongside
  `Provider` in a follow-up; the four-column ledger in
  `eidan.llm_calls` already supports it (only `input_tokens` is
  non-zero).
- **Vision input shape.** The `Message` content payload supports
  image blocks but the per-provider serialisation of those blocks
  is not pinned here. The capabilities flag (`vision`) gates use;
  the wire shape is owned by `004_SCHEMAS.md` once finalised.
- **Audio / TTS / STT.** Out of scope for MVP. If Eidan ships
  voice it will be its own protocol, not a stretching of this one.
- **Self-hosted gateways** (LiteLLM, OpenRouter, Bedrock proxy,
  Vertex AI proxy). The current OpenAI-compatible base (§9.4)
  covers the simple case; a fuller gateway adapter that maps
  gateway-side error shapes back to §8.1 is a follow-up. Plugins
  may ship their own provider in the meantime via §10.4.
- **Adaptive routing.** A layer that chooses between Anthropic and
  OpenAI for the same size class based on observed latency and
  cost. The data is already in `llm_calls`; the policy is not.
- **Per-provider safety overrides.** Gemini accepts
  safety-threshold knobs; OpenAI accepts moderation routes;
  Anthropic accepts none. A future spec defines how — or whether
  — the host surfaces operator-controlled safety knobs uniformly.
  Today the answer is "no overrides; the upstream defaults stand."
- **Cost-budget enforcement.** The hooks exist (cost is on every
  `llm_calls` row, the scope classifier can read a budget) but
  the policy that turns a budget into a refused call is not
  specified here.
