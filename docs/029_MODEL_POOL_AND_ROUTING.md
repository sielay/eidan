# 029 — Model pool, roles, and routing

Status: Draft
Owner: Core
Related: `docs/007_PROVIDER_ABSTRACTION.md` (the per-adapter contract;
this doc extends §6 `ModelInfo`/`Capability`, **supersedes** §7.3
per-agent preference and §10 selection, and **un-defers** §12's
embeddings / vision / audio), `docs/005_AGENTIC_LOOP.md` (§5.3 sizer,
§5.5 primary loop), `docs/010_COST_BUDGETING.md` (§2.1 `llm_calls`
ledger, §3.4 price overrides), `docs/008_SUBAGENT_INVOCATION.md`
(`subagent` role), `docs/001_PLUGINS.md` (plugin-registered roles).

This document specifies how Eidan chooses **which model serves each
call**, across **every modality** (not just text/chat), from a pool
of models contributed by all configured integrations — and how that
choice **drifts at runtime** and **falls back** on failure.

It draws a hard line between two concerns that `docs/007` currently
blends:

- **Integrations** — *credentials*. "Anthropic is configured with
  this key." Per-provider, secret, set once. (`§4`)
- **Routing** — *policy*. "The `primary` role prefers
  `claude-opus`, then `gpt-4o`, then a local model." Per-role,
  ordered, **mutable at runtime**, modality-aware. (`§6`–`§8`)

The payoff is one mechanism that delivers four things the codebase
asks for and `docs/007` only gestures at:

1. **Multiple providers live at once** (cheap classifier on one,
   quality primary on another) — eidan#226.
2. **Fallback** — an *ordered* preference list per role **is** the
   failover chain — eidan#227.
3. **All modalities** — summarisation, image generation, image
   analysis (vision), speech-to-text, text-to-speech, embeddings —
   not only chat completions.
4. **Runtime drift** — the user, or the sizer, re-points a role's
   model without a redeploy.

The current code is the degenerate case: one text provider, one
default model, handed to every call. This doc names the general
shape and the phased path from here to there (`§11`).

---

## 1. Vocabulary

| Term | Meaning |
|------|---------|
| **Integration** | One configured upstream account: a (provider, credentials) pair. `anthropic` + its key; `azure` + endpoint/key; `openrouter` + its key. Enables a **provider adapter** and contributes models to the pool. (`§4`) |
| **Provider adapter** | The code that speaks one upstream's wire protocol for one **modality family** (`docs/007` is the text-modality contract; peer protocols in `§5.3` cover the rest). One integration may expose adapters for several modalities (OpenRouter does text + image; Azure does text + tts + stt + embeddings). |
| **Model** | A specific named endpoint on an integration, e.g. `claude-opus-4-7`, `openai/gpt-4o-mini`, `black-forest-labs/flux-1.1-pro`, `whisper-1`. Identified poolwide by `(integration, id)`; see `ModelRef` (`§3`). |
| **Modality** | The input→output *shape* a model implements: `text`, `vision` (image→text), `image_gen` (text→image), `stt` (audio→text), `tts` (text→audio), `embedding` (text→vector). Distinct from **capability**. (`§3.1`) |
| **Capability** | A feature flag *within* a modality (`docs/007 §6.3`): `tools`, `structured_output`, `streaming`, `long_context`, `cache_native`, `parallel_tool_use`. A `text` model may or may not have `tools`. |
| **Model pool** | The poolwide union of every model every enabled integration exposes, each tagged with its modality, capabilities, and pricing. The thing routes draw from. (`§5`) |
| **Role** | The *purpose* of a call: `primary`, `critic`, `scope_classifier`, … and **plugin-registered** roles. Each role declares the **modality** it needs and an optional **capability requirement**. (`§6`) |
| **Route / preference** | A role's **ordered list** of candidate models (a `ModelRef[]`). First viable wins; the rest are the fallback tail. (`§7`) |
| **Resolution** | Turning a (role, requirements) into the concrete (model, provider adapter) to call, by walking the route against the live pool. (`§7.2`) |
| **Drift** | A runtime change to a route — by the **user** (explicit) or the **sizer** (automatic), without redeploy. (`§9`) |

---

## 2. The two layers, and why they're separate

```
                       ┌───────────────────────────────────────┐
   credentials  ──────▶│ INTEGRATIONS  (§4)                     │
   (per provider,      │   anthropic · openai · google · azure │
    secret, static)    │   · openrouter · ollama · …           │
                       └───────────────────┬───────────────────┘
                                           │ contribute models
                                           ▼
                       ┌───────────────────────────────────────┐
                       │ MODEL POOL  (§5)                       │
                       │   every model × modality × caps × $    │
                       └───────────────────┬───────────────────┘
                                           │ drawn from, filtered by modality
                                           ▼
   policy        ──────▶┌───────────────────────────────────────┐
   (per role,          │ ROUTES  (§6–§7)                        │
    ordered, mutable,  │   role → ordered [ModelRef, …]         │
    modality-aware)    │   primary:    [opus, gpt-4o, llama]   │
                       │   summariser: [haiku, gpt-4o-mini]    │
                       │   image_gen:  [flux-pro, dall-e-3]    │
                       └───────────────────┬───────────────────┘
                                           │ resolve + execute (§7.2, §10)
                                           ▼
                            one upstream call  →  one llm_calls row
```

Separation matters because the two change for different reasons, at
different cadences, with different blast radius:

- **Credentials** are secret, rarely change, and live in the
  operator's environment / vault (`docs/007 §7`, `docs/010 §3.4`).
  Adding an integration should *not* require touching any routing
  policy.
- **Routing** is non-secret policy, **changes often** (a user tries
  a cheaper model; the sizer escalates a hard turn), and wants a
  UI. Coupling it to credentials (today's `EIDAN_PROVIDER` does
  exactly that) makes "use a second provider for classifiers"
  impossible without re-plumbing.

`docs/007 §7.3` put a `provider_preference` blob on `agent_context`;
this doc keeps that *idea* (per-role preference) but (a) makes it
**ordered** (= fallback), (b) makes it **modality-aware**, and (c)
moves it onto its own runtime-mutable surface (`§9`) instead of a
static config field.

---

## 3. Models are graded — modality is first-class

The single biggest departure from `docs/007` (whose protocol is
chat-completions only, §12 deferring the rest): **a model's modality
is part of its identity in the pool**, and a role can only be served
by a model of the modality it needs.

### 3.1 The modality taxonomy

```python
class Modality(str, Enum):
    TEXT      = "text"       # chat / completion           (LLM)
    VISION    = "vision"     # image(+text) -> text        (image analysis)
    IMAGE_GEN = "image_gen"  # text -> image
    STT       = "stt"        # audio -> text               (voice in)
    TTS       = "tts"        # text -> audio               (voice out)
    EMBEDDING = "embedding"  # text -> vector
```

Notes that keep this honest:

- **Vision is usually a capability, not a separate model.** Modern
  chat models accept images (`gpt-4o`, `claude-*`, `gemini-*`). So
  "image analysis" is most often a `TEXT` model carrying the
  `vision` **capability** (`§3.2`), *not* a `VISION`-modality model.
  The `VISION` modality is reserved for endpoints that are
  image-in/text-out *only*. A role that needs to read an image
  requires `modality=TEXT, capability=vision` — the routing filter
  handles both axes uniformly (`§7.2`).
- **Summarisation is a role, not a modality.** It runs on a `TEXT`
  model (`§6`). Don't confuse "what the call is for" (role) with
  "what shape the model is" (modality).
- **Each non-text modality has its own call shape**, so it needs its
  own adapter protocol (`§5.3`). The *routing* layer (`§6`–`§8`) is
  identical across modalities; only *execution* dispatches on
  modality.

### 3.2 `ModelInfo`, extended

`docs/007 §6.1` already defines `ModelInfo` (id, provider, size
class, context window, capabilities, pricing). This doc adds one
required field and generalises pricing:

```python
@dataclass(frozen=True, slots=True)
class ModelInfo:
    id:             str
    integration:    str                 # was `provider` — the integration name
    modality:       Modality            # NEW — §3.1
    size_class:     SizeClass | None     # text only; None for non-text
    capabilities:   frozenset[Capability]
    pricing:        Pricing             # per-modality unit (§3.3)
    context_window: int | None           # text only
    aliases:        tuple[str, ...] = ()
    deprecated_at:  str | None = None
```

### 3.3 Pricing is per-modality

`docs/007 §6.4`'s four-axis token `Pricing` is a `TEXT`-shaped
assumption. The pool prices each modality in its own unit, all
still landing as `cost_usd` on the `llm_calls` row (`docs/010 §2.1`):

| Modality | Billed unit |
|----------|-------------|
| `text` / `vision` | input / output / cache-read / cache-creation **tokens** (`docs/007 §6.4`) |
| `embedding` | input tokens |
| `image_gen` | per image (× size/quality tier) |
| `stt` | per second / per minute of audio |
| `tts` | per character (or per second of output) |

For OpenRouter and any gateway that returns a per-call cost, the
**native `usage.cost`** path (eidan#219, `OpenRouterProvider`) is the
source of truth regardless of modality — which is exactly why it
generalises so well: a 200+-model, multi-modality catalogue can't be
hand-priced, and the gateway already tells us the cost.

---

## 4. Integrations (the credentials layer)

An integration is a (provider, credentials) pair the operator
configures once. Presence of credentials = the integration is
enabled and its adapters + models join the pool. This is the
**only** thing the operator sets per provider; it carries **no
routing policy**.

Per the gitignored-config policy (`CLAUDE.md`), credentials come
from env / vault / topology, never tracked files:

```
ANTHROPIC_API_KEY=…            # enables `anthropic`
OPENAI_API_KEY=…               # enables `openai`
GEMINI_API_KEY=…               # enables `google`
AZURE_OPENAI_ENDPOINT=…  AZURE_OPENAI_API_KEY=…   # enables `azure`
OPENROUTER_API_KEY=…           # enables `openrouter`  (eidan#219)
OLLAMA_BASE_URL=…              # enables `ollama` (no key)
```

Multiple integrations enabled simultaneously is the **normal** case
(today's single-`EIDAN_PROVIDER` install is the degenerate one). The
registry builds an adapter for each enabled integration at startup;
a missing/invalid credential disables just that integration and logs
it (`docs/007 §7.1`), the pool simply carries fewer models.

`EIDAN_PROVIDER` / `EIDAN_DEFAULT_MODEL` are retained as the
**default route** seed (`§8`) for backwards compatibility, not as the
sole provider selector.

---

## 5. The model pool and the registry

### 5.1 What's in the pool

At startup (and on integration (de)activation) the **`ProviderRegistry`**
assembles the pool: for each enabled integration, the set of
`ModelInfo` it exposes, keyed poolwide by `ModelRef`:

```python
@dataclass(frozen=True, slots=True)
class ModelRef:
    integration: str     # "anthropic", "openrouter", "azure", …
    id:          str     # "claude-opus-4-7", "openai/gpt-4o-mini", …
    # str form: "anthropic:claude-opus-4-7" — what routes serialise
```

`ModelRef` is poolwide-unique on purpose: the *same* model id can
arrive via two integrations (e.g. `claude-3.5-sonnet` direct from
`anthropic` **and** as `anthropic/claude-3.5-sonnet` via
`openrouter`). Routing distinguishes them — direct-vs-gateway is a
real choice (cost, latency, which balance gets billed).

### 5.2 How a model gets into the pool

| Integration | Model discovery |
|-------------|-----------------|
| anthropic / openai / google / azure / mistral | A curated `ModelInfo` table shipped per adapter (`docs/007 §6.2`), price-overridable via `docs/010 §3.4`. |
| openrouter | The live `GET /models` catalogue (hundreds, multi-modality), with native per-call pricing (`§3.3`). Refreshed periodically; seeded from a snapshot. |
| ollama / llama.cpp | Operator-declared in local config (`docs/007 §7.4`). |

### 5.3 Execution protocols per modality

`docs/007` is the `TEXT` adapter contract. The other modalities are
**peer protocols** with the same lifecycle/accounting shape but
different call signatures — sketched here, pinned in follow-ups:

```python
class TextProvider(Protocol):     ...   # = docs/007 Provider
class EmbeddingProvider(Protocol):
    async def embed(self, *, model, inputs) -> EmbedResult: ...
class ImageGenProvider(Protocol):
    async def generate(self, *, model, prompt, size, n) -> ImageResult: ...
class SttProvider(Protocol):
    async def transcribe(self, *, model, audio) -> SttResult: ...
class TtsProvider(Protocol):
    async def synthesize(self, *, model, text, voice) -> TtsResult: ...
```

Every one returns a result carrying the same accounting fields
(`docs/007 §4`) so **one `llm_calls` row shape covers all
modalities** (`docs/010 §2.1`; the `embed` role already exists in the
closed role set, and the ledger is modality-agnostic). The
**routing** layer below never branches on modality; only the final
dispatch does.

---

## 6. Roles

A role is the *purpose* of a call. Each role declares the
**modality** (and optional **capability**) it requires, so the
router only ever offers it compatible models.

### 6.1 Core roles (closed set, today)

The `llm_calls_role_chk` set
(`migrations/…_llm_calls_role_intent.py`):
`primary`, `critic`, `scope_classifier`, `intent_classifier`,
`sizer`, `summariser`, `tool_synthesis`, `subagent`, `embed`,
`other`. Their declared requirements:

| Role | Modality | Cap | Notes |
|------|----------|-----|-------|
| `primary` | text | tools | the answer; quality-critical |
| `critic` | text | — | bicameral critique |
| `scope_classifier` | text | structured_output | skill tags |
| `intent_classifier` | text | structured_output | intent |
| `sizer` | text | structured_output | picks `primary`'s model (`§9.2`) |
| `summariser` | text | — | context compaction |
| `tool_synthesis` | text | — | summarise tool output |
| `subagent` | text | tools | spawned turn (`docs/008`) |
| `embed` | embedding | — | vectors |
| `other` | text | — | catch-all |

Future first-class roles as modalities land: `voice_in` (stt),
`voice_out` (tts), `image_create` (image_gen), `image_read`
(text+vision).

### 6.2 Plugin-registered roles

Roles are **not** a forever-closed set. A plugin (`docs/001`) may
register a role via `PluginContext` (symmetric to
`register_provider`, `docs/007 §10.4`), declaring its modality +
capability requirement and a default route. Registration:

- relaxes the `llm_calls_role_chk` constraint into an
  **extensible** form (a `roles` lookup table the constraint FKs to,
  rather than a hard-coded `CHECK (role IN …)`), so a plugin's role
  is a first-class ledger citizen for cost + caps (`docs/010 §4`);
- namespaces plugin roles (`plugin_<name>.<role>`) to avoid
  collision with the core set.

This is what lets a "podcast" plugin add a `voice_out` role, or a
"vision-notes" plugin add an `image_read` role, and have each routed
+ billed like any core call.

---

## 7. Routes — ordered, modality-aware preferences

### 7.1 Shape

A route maps a role to an **ordered list** of `ModelRef`s:

```python
Route = list[ModelRef]                 # priority order
Routes = dict[str, Route]              # role -> route
```

Example (config-seeded, `§8`):

```jsonc
{
  "primary":     ["anthropic:claude-opus-4-7",
                  "openrouter:openai/gpt-4o",
                  "ollama:llama3.1:70b"],
  "summariser":  ["anthropic:claude-haiku-4-5",
                  "openrouter:openai/gpt-4o-mini"],
  "scope_classifier": ["openrouter:openai/gpt-4o-mini"],
  "embed":       ["openai:text-embedding-3-small"],
  "image_create":["openrouter:black-forest-labs/flux-1.1-pro",
                  "openai:dall-e-3"]
}
```

### 7.2 Resolution

To serve a call for `role`:

1. Look up `route = Routes[role]` (or the **default route**, `§8`,
   if unset).
2. Walk the route in order. For each `ModelRef`:
   - the model must be **in the live pool** (its integration is
     enabled);
   - its `modality` must match the role's required modality;
   - it must carry the role's required **capability**, if any;
   - (fallback only) it must not be in the per-turn *tried-and-failed*
     set (`§10`).
3. The **first** `ModelRef` passing all filters is resolved to its
   adapter via the registry and called.
4. None viable → typed `RoutingError` (no compatible/enabled model
   for the role) → surfaced like any provider failure
   (`docs/005 §6.5`).

The filter is one pass over `(enabled, modality, capability)` — the
same code whether the list has one entry (no fallback) or five
(deep fallback). **#226 and #227 are the same resolver**, the only
difference is how far down the list a turn walks.

---

## 8. Configuration surface (seeded now, DB later)

Phase 0 keeps routing **static, config-seeded** — no new storage:

- **Code defaults** ship a sane `Routes` for the core roles, derived
  from whichever integrations are enabled (e.g. if only `anthropic`
  is up, every text role routes to a Claude tier — today's
  behaviour exactly).
- **Env seed** overrides per role, flat and discoverable:

  ```
  EIDAN_ROUTE_PRIMARY=anthropic:claude-opus-4-7,openrouter:openai/gpt-4o
  EIDAN_ROUTE_SCOPE_CLASSIFIER=openrouter:openai/gpt-4o-mini
  EIDAN_ROUTE_SUMMARISER=anthropic:claude-haiku-4-5
  ```

  (comma-separated `ModelRef`s = the ordered route). Unset role →
  **default route**: the legacy `EIDAN_PROVIDER:EIDAN_DEFAULT_MODEL`
  if set (preserving the current single-provider install verbatim),
  else the **cheapest** compatible model in the pool (`§12`).

- The legacy `EIDAN_CLASSIFIER_MODEL` / `EIDAN_SIZER_ENABLED` map
  onto routes for one release, then deprecate.

Phase 2 (`§9`) adds the **DB** surface for runtime drift; the env
seed becomes the *initial* value, not the only one.

---

## 9. Runtime drift

Routes are **policy**, and policy changes without a redeploy.

### 9.1 Who changes a route

- **The user** — explicitly: "use gpt-4o for primary", a settings
  UI (the model-exploration surface), or a command. This writes the
  role's route.
- **The sizer** (`docs/005 §5.3`) — automatically: it already picks
  `primary`'s model by difficulty. Re-framed here, the sizer emits a
  **`size_class`**, and the resolver **filters `primary`'s route to
  that class** (first match wins, `§12`) — it never names a bare
  model. Budget pressure (`docs/010 §13`) likewise biases cheaper by
  narrowing to a lower class / preferring lower-cost pool entries.

### 9.2 Where drift lives

Per the chosen scope (config-seeded now, DB later): Phase 2 adds an
`eidan.role_routes` table (global host scope first; per-agent
overrides via `agent_context` a later layer), read at turn start,
written by the user/sizer paths. Defaults seed from `§8`. The
**frozen-vs-live** discipline mirrors `docs/010 §2.1`: a route change
affects *future* calls only; the `llm_calls` row records the
`ModelRef` actually used, so history is exact.

---

## 10. Fallback = walking the route

`docs/007 §6.4`/§8 already normalise provider errors into a typed
hierarchy with a `retryable` flag. Fallback is just: **on a
fallible error, advance to the next `ModelRef` in the route.**

```
for ref in resolve_candidates(role):        # §7.2, in order
    try:
        return await call(ref, …)            # one llm_calls row
    except ProviderError as e:
        if not _fallover_eligible(e): raise   # bad-request/content/context → stop
        mark_tried(ref); continue             # rate-limit/credits/5xx/transient → next
raise RoutingExhaustedError(role)             # walked the whole list
```

- **Eligible → advance:** `ProviderRateLimitError`,
  `ProviderOverloadedError`, `Provider5xxError`,
  `ProviderTransientError`, and the out-of-credits flavour of
  `ProviderAuthError`.
- **Not eligible → stop:** `ProviderBadRequestError`,
  `ProviderContentPolicyError`, `ProviderContextOverflowError`,
  `ProviderCapabilityError` — the next model would fail identically
  or needs a different fix (compaction, not failover).
- **Each attempt is its own `llm_calls` row** (`docs/010 §2.1`
  "retries are separate rows"), linked via `metadata.fellover_from`,
  so cost + caps + the dashboard see every attempt and *which*
  integration ultimately served.
- **Bounded:** the route length caps the walk; no infinite loops.
- OpenRouter already does cross-*vendor* failover **inside one
  integration** server-side (eidan#219); this is the cross-*integration*
  chain (e.g. `anthropic`-direct → `openrouter` gateway), complementary
  and one level up.

---

## 11. Phasing

| Phase | Lands | Issue |
|-------|-------|-------|
| **0** | `ProviderRegistry` builds all credentialed integrations; **text** model pool; `Routes` (config + env seed, `§8`); resolver (`§7.2`) wired through the loop + classifiers; per-call provider resolution. Backwards-compatible. | #226 |
| **1** | Route execution as **fallback** (`§10`): error-class gating, one `llm_calls` row/attempt. | #227 |
| **2** | **Runtime drift** (`§9`): `eidan.role_routes` DB table, user + sizer mutate; sizer re-expressed as route selection. | new |
| **3** | **Breadth**: Google + Azure text adapters; the **non-text modalities** (`§3`, `§5.3`) — embeddings first (role exists), then stt/tts/image_gen peer protocols + pool entries. | new |
| **4** | **Plugin-registered roles** (`§6.2`, relax the closed `role` CHECK); the **model-exploration / selection UI** over the pool + routes. | new |

Phase 0 is deliberately text-only and static so it lands small and
reviewable; the modality + drift + plugin layers stack on a stable
core. Each phase is independently shippable.

---

## 12. Decisions and open questions

**Decided** (operator, 2026-06-07):

- **Default route = cheapest compatible.** When a role has no
  explicit route, the resolver picks the **cheapest** pool model of
  the required modality (+ capability). The legacy
  `EIDAN_PROVIDER`/`EIDAN_DEFAULT_MODEL` default, if set, still pins
  the route (backwards compat); absent it, cheapest wins. (Cost is
  the tiebreak everywhere — "cheap is best" for unrouted roles.)
- **Sizer emits a `size_class`; the resolver filters the route by
  it** (`§9.2`), not a bare `ModelRef`. The route stays the ordered
  candidate source (and fallback tail); the sizer narrows it to a
  class and the first match wins. Policy ("which models") lives in
  the route; difficulty ("how big") lives in the sizer.
- **Cross-modality = `primary` spawns a sub-call.** An "answer with
  an image" turn is the `primary` role spawning an `image_create`
  sub-call through the existing tool/spawn surface (`docs/008`), not
  one role issuing two heterogeneous calls. Each call keeps its own
  role, route, and `llm_calls` row.

**Still open:**

- **Per-agent vs global routes** ordering once both exist — `min`/
  override semantics, mirroring `docs/010 §4.7`'s budget resolution.
- **Pool freshness** for OpenRouter's `/models` — TTL, and behaviour
  when a previously-routed model leaves the catalogue.
- **Capability mismatch at runtime** — a user routes `primary` to a
  no-tools model; reject at route-write or fail the call? (Leaning:
  reject at write, like `docs/007 §6.3`'s build-time check.)
