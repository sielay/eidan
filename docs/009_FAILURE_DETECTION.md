# 009 — Failure detection signals

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Agentic loop, Bicameral critique),
`docs/003_MEMORY_DDL.md` (§3 `messages`, §9 `llm_calls`),
`docs/004_SCHEMAS.md` (`agentic/*` DTOs),
`docs/005_AGENTIC_LOOP.md` (§5.5 primary loop, §5.7 failure
detector, §5.8 critic), `docs/006_BEHAVIOURS_TRIGGERS.md`
(§5 classifier), `docs/008_SUBAGENT_INVOCATION.md` (§3 spawn
protocol, §9.3 critic call site)

This document specifies how the runner decides that **the primary
model's output is suspect and the critic should be convened**. It
is the trigger for the bicameral critique pattern outlined in
`005_AGENTIC_LOOP.md §5.7–§5.8`: the primary speaks first and
acts; the critic speaks second and reviews — but only when
something looks wrong. This spec fixes what "looks wrong" means.

`005 §5.7` listed seven within-turn signals as a sketch. This
document supersedes that section: it pins down the full signal
set (within-turn **and** cross-turn), specifies when each phase
runs in the turn lifecycle, defines the classifier fallback for
cases the heuristics cannot decide, and budgets the cost so we
can be confident the detector pays for itself on the populations
where it fires.

Out of scope (deferred to follow-ups, see §11):

- The exact natural-language prompt for the classifier fallback —
  owned by the prompt library, with a stable JSON Schema output
  defined here.
- Per-user adaptation (a user who routinely uses caps is not
  frustrated; a user who never does is). The signal definitions
  are population defaults; per-user calibration is its own spec.
- The UI affordance ("we double-checked this") that surfaces a
  critic intervention to the user. Owned by the frontend spec.

---

## 1. Vocabulary

| Term                       | Meaning                                                                                                                                                |
|----------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Detector**               | The runner step that decides whether the critic should fire. Composed of two phases (pre-primary, post-primary) plus an optional classifier fallback.    |
| **Signal**                 | A named, structured observation produced by the detector — e.g. `loop_exhausted`, `near_identical_user_msg`. Each signal carries a confidence score.    |
| **Heuristic**              | A deterministic rule that produces a signal. Cheap (≤ a few ms), no LLM call.                                                                            |
| **Classifier fallback**    | A small-model LLM call (`failure_classifier` role) that runs **only** when heuristics are inconclusive and the turn meets the fallback gate (§6.2).      |
| **Pre-primary phase**      | The detector pass that runs before the primary call, against the inbound user message and recent history.                                                |
| **Post-primary phase**     | The detector pass that runs after the primary's final response (the existing `005 §5.7` step ⑦).                                                          |
| **`FailureSignal`**        | The structured DTO the detector returns. Read by the critic; persisted on the anchor message's `metadata.failure`.                                       |
| **Should-critique decision** | The boolean output `FailureSignal.should_critique`. The critic (`005 §5.8`) runs iff this is true.                                                      |
| **Confidence**             | A `float ∈ [0, 1]` attached to each emitted signal. Heuristics emit either `1.0` (rule matched) or `0.0` (did not match); the classifier emits in-between values. |

The detector is **not** the critic. The detector decides *whether*
to think harder; the critic does the harder thinking. Keeping the
two roles separate matters because the detector runs every turn
and the critic does not — bundling them would multiply the
detector's cost by the critic's.

The classifier fallback **is** the only place the detector itself
spends an LLM call. It maps onto a new value of
`eidan.llm_calls.role` — `failure_classifier` — added as an
additive migration to `llm_calls_role_chk` (`003 §9`), alongside
the other new roles enumerated in `005 §7`.

---

## 2. Where the detector runs in the turn

`005 §3` describes the turn as ten ordered steps. The detector
participates in **two** of them and adds **one** new one:

| Loop step    | Detector role                                                                                                                |
|--------------|------------------------------------------------------------------------------------------------------------------------------|
| ②.5 (new)    | **Pre-primary pass** — runs immediately after the inbound user message is persisted and before step ③ (scope classifier).    |
| ⑥            | No detector work. The primary loop's own bounds (loop iteration cap, §5.5) feed signals into the post-primary pass.          |
| ⑦            | **Post-primary pass** — the existing `005 §5.7` step. Examines the primary's final response and the within-turn history.    |
| ⑦.5 (new)    | **Classifier fallback** (conditional) — runs only when post-primary heuristics are inconclusive and §6.2's gate holds.        |
| ⑧            | The critic reads the `FailureSignal` that the detector emitted; does not re-run detection.                                   |

The placement choice is deliberate:

- **Pre-primary, not pre-scope.** The scope classifier is itself
  a guard against bad inputs (`005 §5.2`). Running the failure
  detector *before* scope would mean we double up the cost on
  every turn — most turns do not need a pre-primary failure
  check. Running it *between* user-message persistence and scope
  is wrong for the opposite reason: scope already needs the
  recent history, and we want its output to inform whether the
  pre-primary pass even fires. The chosen point — after scope
  but before sizer — gives the pre-primary pass scope's verdict
  to read.

- **Post-primary, before agent router.** The router (`005 §5.10`)
  reads the final assistant message and decides which background
  agents react. A response that the critic later rewrites would
  cause the router to fan out on the *wrong* text. The detector
  must run, the critic must conclude, and synthesis must commit
  the chosen response — *then* the router runs. This is the
  ordering `005 §3` already encodes; the spec here is its
  failure-detector half.

The updated step list is the same one in `005 §3`, with two
inserts:

```
② persist user msg
②.5 detector — pre-primary pass
③ scope classifier
④ sizer
⑤ behaviours + tool surface
⑥ primary loop
⑦ detector — post-primary pass
⑦.5 detector — classifier fallback (conditional)
⑧ critic (conditional)
⑨ synthesis
⑩ agent router
```

`005 §3` will be updated to point at this document for steps
②.5, ⑦, and ⑦.5; the canonical diagram stays there.

---

## 3. The signal catalogue

This is the **complete** list of signals the detector emits. New
signals require an additive migration to the catalogue here and
a corresponding entry in the `FailureSignal` schema (`004 §X`,
to be defined when stable). Removing a signal is a breaking
change for any downstream that reads `messages.metadata.failure`;
deprecate first, remove next major.

Each signal has:

- A **name** (snake_case, stable identifier).
- A **definition** (mechanical, deterministic for heuristics; a
  short rubric for the classifier-emitted ones).
- A **phase** (`pre`, `post`, or `both`).
- A **default weight** (a float; the should-critique aggregator
  in §7 sums these).

### 3.1 Within-turn signals (post-primary phase)

These re-state and extend `005 §5.7`. Every signal in this group
is computed against the **current turn only** — the user
message, the assistant turn(s) the primary emitted, and any
tool turns between them. No cross-turn lookup.

| Name                  | Definition                                                                                                                            | Phase  | Weight |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------|--------|--------|
| `empty_response`      | The final assistant turn has `content == ""` and `tool_calls == []`.                                                                  | post   | 1.0    |
| `loop_exhausted`      | The primary loop hit its iteration cap (`005 §5.5`, default 12) without producing a terminal text response.                            | post   | 1.0    |
| `tool_storm`          | More than 6 tool calls in the turn with no terminal text response.                                                                    | post   | 0.8    |
| `repeated_tool`       | The same `(tool_name, normalized_args_hash)` invoked ≥ 3 times in the same turn. `normalized_args_hash` ignores whitespace and key order. | post   | 0.7    |
| `refusal`             | The final assistant text matches a refusal-prefix regex set (see §3.4) **and** `scope.action == proceed` (so the refusal is unexpected). | post   | 0.6    |
| `low_confidence`      | The primary emitted a structured `confidence` field on its response under `host.config.failure.low_confidence_threshold` (default 0.4). | post   | 0.5    |
| `tool_errors_left`    | The last assistant turn followed a `tool` turn whose result was an error block, and the assistant neither re-attempted nor surfaced the error to the user. | post   | 0.7    |
| `truncated_output`    | The primary call returned with `truncated=True` (`007 §4.4`) — the response was cut by max tokens, stream abort, or per-call timeout.   | post   | 0.5    |
| `tool_errors_storm`   | More than 3 tool-result error blocks in the same turn, regardless of the assistant's reaction.                                          | post   | 0.6    |
| `schema_failure_left` | The primary emitted a structured-output block that the response-format validator rejected (`007 §3.3`), and the model did not recover. | post   | 0.9    |

`empty_response`, `loop_exhausted`, and `schema_failure_left`
have weight `1.0`: any one of them, alone, is sufficient to
trigger the critic. Lower-weight signals trigger only when one
or more co-occur, per §7's aggregation rule. The weights are
the **defaults** the host ships; they are tunable per agent via
`agent_context.user_overrides.failure.weights` (`003 §7`).

### 3.2 Cross-turn signals (pre-primary phase)

These are the signals the issue specifically asks for —
detection of failure *before* the primary spends a large-model
budget repeating a mistake it already made. Each rule looks at
recent messages from `eidan.messages` for the same conversation,
oldest→newest, bounded by `host.config.failure.lookback_messages`
(default 12 messages = ~ 6 user/assistant pairs).

| Name                       | Definition                                                                                                                                                                                                                                                | Phase | Weight |
|----------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------|--------|
| `near_identical_user_msg`  | Normalised cosine similarity between the **current** user message and **any** prior user message in the lookback window is ≥ `host.config.failure.near_identical_threshold` (default 0.92). Normalisation lowercases, strips punctuation, and collapses whitespace. | pre   | 0.9    |
| `repeated_correction`      | The current user message starts with one of the correction prefixes (§3.4) **and** the immediately preceding assistant message exists. Variants: "no,", "no not", "i said", "you misunderstood", "that's not", "stop", "wrong".                            | pre   | 0.9    |
| `frustration_marker`       | The current user message contains any tokens / patterns from the frustration lexicon (§3.4): explicit profanity targeted at the agent, multi-character punctuation runs (`!!!`, `??`), ALL-CAPS spans ≥ 4 words, or explicit dissatisfaction (`useless`, `not helpful`, `disappointing`).  | pre   | 0.7    |
| `dialogue_loop`            | The previous `K` assistant messages (K = `host.config.failure.loop_K`, default 3) all match the same structural pattern: same opening 40 chars OR same tool sequence OR same refusal prefix. Detects "the agent keeps saying the same thing."             | pre   | 0.8    |
| `escalating_specificity`   | The current user message contains a strict superset of the previous user message's *content tokens* (after stop-word removal) and is at least 1.5× longer. Signal that the user is re-asking with more detail because the prior answer missed.            | pre   | 0.5    |
| `direct_correction_phrase` | The user message contains an exact phrase from a small fixed list: "that's wrong", "you're wrong", "incorrect", "no that is not", "i didn't ask for that", "read it again". Distinct from the prefix-only `repeated_correction`: this matches mid-message too. | pre   | 0.8    |
| `unanswered_question`      | The previous user message contained a `?` and the assistant's reply was a refusal (matched by `refusal` regex from §3.4) — and the current user message also contains a `?`. Detects "ask, refuse, ask again."                                              | pre   | 0.6    |
| `silent_tool_failure_trail` | In the last `lookback_messages`, ≥ 2 tool turns carried error blocks that the assistant did not surface to the user (per `tool_errors_left` definition). Indicates the agent is hiding failures.                                                          | pre   | 0.6    |

The pre-primary phase, like the post-primary one, is purely
deterministic. Cosine similarity in `near_identical_user_msg`
uses a small in-process embedding (the same one the indexer
uses for `eidan.memory_chunks`; if the embedding service is
unavailable, the signal falls back to character-shingle
Jaccard similarity at threshold 0.85, which is cheaper and
imperfect but never blocks the turn).

### 3.3 Cross-cutting signals (both phases)

A small group of signals can fire from either phase, depending
on what's already known:

| Name                | Definition                                                                                                                            | Phase | Weight |
|---------------------|----------------------------------------------------------------------------------------------------------------------------------------|-------|--------|
| `sensitivity_high`  | `scope.sensitivity == high`. Not a failure by itself; it lowers the should-critique threshold (§7). Emitted by the pre-primary phase after scope. | both  | 0.0\*  |
| `prior_critic_fired`| Any of the previous `lookback_messages` carries `metadata.critic.verdict != null`. Indicates the conversation has needed help before.   | pre   | 0.3    |

\* `sensitivity_high` does not contribute to the weight sum;
instead it adjusts the aggregator's threshold (§7.2).

### 3.4 The fixed lexicons

The detector ships with three closed regex / phrase lists.
They live in `eidan/runner/failure/lexicons.py` and are loaded
once per process. Updates ship in core revisions.

**Refusal prefixes** (`refusal`, `unanswered_question`):

```
^I (cannot|can't|won't|will not|am unable|am not able)
^I'm (sorry|afraid).{0,30}(can|cannot|can't|won't)
^As an? (AI|assistant).{0,40}(can|cannot|can't|won't)
^Unfortunately, I (cannot|can't|won't)
^That (is|'s) (outside|beyond) my (scope|capabilities)
```

**Correction prefixes** (`repeated_correction`):

```
^(no\b|no,|no not|nope\b)
^(i said|i meant|i didn't say|i did not say)
^(you (misunderstood|misread|got it wrong))
^(that(\s|'s)not (what|right))
^(stop|wait)\b
^wrong\b
```

**Frustration lexicon** (`frustration_marker`):

```
useless | not helpful | unhelpful | disappointing
ridiculous | dumb | terrible answer
[!]{3,} | [?]{2,}
\b([A-Z][A-Z\s]{15,})\b   # ≥ 4-word ALL-CAPS spans, rough
```

(Targeted profanity matching is config-gated; the default
shipped lexicon errs toward **under**-matching to avoid
false positives on technical conversation. The profanity
extension lives in `eidan/runner/failure/lexicons_profanity.py`
and is opt-in per host.)

These lexicons are English-default. Localised lexicons load
from the same module under `lexicons_{locale}.py`. The
locale is taken from `agent_context.user_overrides.locale`
(`003 §7`); absent that, the host config; absent that,
`en`.

---

## 4. The pre-primary pass (step ②.5)

```python
async def detect_pre_primary(
    ctx: TurnContext,
    user_msg: Message,
    scope_hint: ScopeResult | None = None,   # not yet available; usually None
) -> FailureSignal:
    """Cheap, deterministic, no LLM call.

    Reads up to `host.config.failure.lookback_messages` prior
    messages from eidan.messages for the same conversation and
    runs the rules in §3.2 against them plus the current user
    message. Returns a FailureSignal with the matched signals;
    `should_critique` is NOT decided here (the aggregator runs
    after both phases — see §7).
    """
    history = await ctx.repo.recent_messages(
        ctx.convo.id,
        limit=ctx.host.config.failure.lookback_messages,
    )
    signals: list[Signal] = []

    # §3.2 rules — each is a function that returns Signal | None.
    for rule in PRE_PRIMARY_RULES:
        s = rule(user_msg, history, ctx.host.config.failure)
        if s is not None:
            signals.append(s)

    return FailureSignal(
        phase="pre",
        signals=signals,
        truncated_lookback=(len(history) == ctx.host.config.failure.lookback_messages),
    )
```

The pre-primary pass writes its result onto the inbound user
message's `metadata.failure_pre` so the post-primary pass and
the critic can read it without re-running. It does **not** by
itself trigger the critic; the aggregator in §7 decides after
the post-primary pass has run.

The pre-primary `FailureSignal` is also handed to the **sizer**
(`005 §5.3`): a turn that already carries `near_identical_user_msg`
or `repeated_correction` should be sized up. The sizer reads
`metadata.failure_pre.signals` and shifts model class one tier
up if the weight sum exceeds `host.config.failure.sizer_bump_threshold`
(default 0.8). This is independent of whether the critic
eventually fires — it is the runner's "this turn already
deserves more thought before we burn the budget" hedge.

### 4.1 Scope feedback

After the scope classifier runs (step ③), the runner re-evaluates
two signals that need `scope`:

- `sensitivity_high` is set iff `scope.sensitivity == high`.
- `refusal` (if any prior assistant in the window matched the
  refusal regex) **only counts** when `scope.action == proceed`,
  matching the original `005 §5.7` rule. Pre-scope, it sits as
  a candidate; post-scope, it is committed or dropped.

The implementation does this as a small "finalize_pre_after_scope"
helper inside the runner; it does not require re-reading the
history.

### 4.2 The cost of the pre-primary pass

The pass reads at most `lookback_messages` rows and runs ~ 8
regex / similarity checks against them. Empirically (to be
validated post-MVP): under 5 ms on the worker, dominated by
the DB read. No LLM call. No tokens spent.

A pass that hits the embedding service (for
`near_identical_user_msg`) pays the embedding cost — which is
on the order of $0.00001 per user message at current Anthropic
embedding pricing. Cheaper still on a self-hosted embedder.
This is below the noise floor of the per-turn cost dashboard.

---

## 5. The post-primary pass (step ⑦)

```python
def detect_post_primary(
    primary_state: PrimaryState,
    final_msg: Message,
    pre_signal: FailureSignal,
) -> FailureSignal:
    """Cheap, deterministic, no LLM call.

    Examines the primary's final assistant turn and the turn's
    internal tool-loop history. Combines with the pre-primary
    pass into a single FailureSignal carrying signals from both
    phases.
    """
    signals = list(pre_signal.signals)
    for rule in POST_PRIMARY_RULES:
        s = rule(primary_state, final_msg)
        if s is not None:
            signals.append(s)
    return FailureSignal(
        phase="post",
        signals=signals,
        truncated_lookback=pre_signal.truncated_lookback,
    )
```

The post-primary pass is the existing §5.7 step extended with
the new signals in §3.1 (`truncated_output`, `tool_errors_storm`,
`schema_failure_left`). Its inputs are the primary's last
`Message` and the in-memory state the primary loop maintained
(tool-call history, error blocks, etc.).

It does NOT re-read the DB. Every input it needs has already
been materialised by the primary loop.

### 5.1 Cost of the post-primary pass

A handful of dict accesses and regex matches over a single
assistant turn's content. Sub-millisecond. No LLM call.

---

## 6. Classifier fallback (step ⑦.5)

The two heuristic phases are conservative — they prefer false
negatives to false positives. A turn where the user is *subtly*
frustrated, or where the assistant is *almost* refusing, or
where the answer is *just slightly* off — none of these reliably
trigger a heuristic. For turns where the heuristics are
**inconclusive** but **the stakes warrant a second look**, the
detector falls back to a small classifier LLM call.

### 6.1 What the classifier reads

The classifier is a helper spawn (`008 §3`, flavour HELPER) with
the following inputs:

- The current user message.
- The primary's final assistant message (content only — no
  tool blocks).
- The last `K` messages (K = `host.config.failure.classifier_context`,
  default 6) of the conversation.
- The summary of heuristic findings: which signals fired, with
  weights, and the aggregator's score (see §7).
- A short fixed prompt that defines the classification schema.

The classifier model class is **small** (Haiku-class). A larger
model would be the critic itself; the whole point of the
detector is to be cheaper than running the critic blind.

### 6.2 When the classifier fires

The classifier runs **only if** all of the following hold:

1. **Heuristics are inconclusive.** The aggregator's score
   (`§7.1`) is in the band `[low, high]` =
   `[host.config.failure.classifier_low_band,
   host.config.failure.classifier_high_band]` (defaults
   `0.3`–`0.7`). Below `low`, the critic is skipped without
   asking. Above `high`, the critic runs without asking.

2. **At least one of these holds:**
   - `sensitivity_high` is set (the turn is sensitive enough
     that a missed problem is costly).
   - `prior_critic_fired` is set (the conversation has needed
     help before; we lean toward more help).
   - `scope.action != proceed` is false (i.e. we ARE proceeding)
     and the agent's `agent_context.user_overrides.failure.classifier_enabled`
     is `true`. Most agents leave this default `false`; only
     the agents whose operators have opted in pay for the
     classifier on inconclusive turns.

3. **Budget allows.** The host config carries
   `host.config.failure.classifier_max_per_minute` (default 30
   per worker). If exceeded, the classifier is skipped and the
   detector falls through with the heuristic score.

This gating is deliberate. Item 1 says "only when we genuinely
don't know"; item 2 says "and only when not knowing is risky";
item 3 says "and only when the host has the budget for it."

The default population — non-sensitive turns on an agent that
has not opted in — never pays the classifier cost. See §8.

### 6.3 The classifier output

```ts
type FailureClassifierResult = {
  judgement: "ok" | "off_rails" | "uncertain";
  signals: Array<{
    name: string;             // one of: "subtle_refusal" | "answer_drift"
                              // | "user_dissatisfied" | "tone_mismatch"
                              // | "missed_intent" | "stalled_progress"
    confidence: number;       // [0, 1]
  }>;
  rationale: string;          // <= 200 chars; auditable, not user-facing
};
```

The classifier emits its own set of signal names, parallel to
the heuristic catalogue but distinguished by prefix in
persistence (`metadata.failure.signals[].source = "classifier"`).
They count toward the should-critique decision with their
returned `confidence` as the weight; the aggregator multiplies
by `host.config.failure.classifier_signal_weight` (default 0.8)
to nudge classifier-emitted signals slightly under heuristic
ones — heuristics are cheaper to re-derive and easier to audit.

A classifier that returns `"ok"` reduces the heuristic score
by `host.config.failure.classifier_ok_dampener` (default 0.4).
A classifier that returns `"off_rails"` adds a single
high-confidence signal (`classifier_off_rails`, weight 0.9).
A classifier that returns `"uncertain"` is a no-op — the
heuristic score stands.

### 6.4 Spawn shape

```python
result = await spawn(ctx, SpawnRequest(
    role             = "failure_classifier",
    flavour          = SpawnFlavour.HELPER,
    request_id       = ctx.trace.new_request_id(),
    model            = host.config.classifier_model,   # small class
    system           = FAILURE_CLASSIFIER_PROMPT,
    messages         = build_classifier_context(ctx, final_msg, pre_signal, post_signal),
    response_format  = FAILURE_CLASSIFIER_RESULT_SCHEMA,
    parent_message_id = ctx.user_msg.id,
    parent_user_id    = ctx.user_msg.user_id,
    parent_agent_id   = ctx.convo.agent_id,
    timeout_s         = 10.0,
    cancel_token      = ctx.cancel.child(10.0),
    depth             = ctx.trace.depth,
))
```

On `ok=False` (spawn timed out, provider failed, schema
violation), the detector proceeds with the heuristic score
alone. Failure here is **non-blocking** — the detector's job is
to be cheap, not to be authoritative.

### 6.5 Cost of the classifier

A Haiku-class call on a prompt of ~ 600 input tokens and ~ 80
output tokens: about $0.0002 per call at current pricing. With
default gating (§6.2), the fire rate on a population of
non-failing turns is well under 5% (§8); the per-turn
amortised cost is below $0.00001. The classifier is the only
budget item in the whole detector and it is rounding noise on
the per-turn cost dashboard.

---

## 7. Aggregation and the should-critique decision

The detector returns a single `FailureSignal` whose
`should_critique` field is what the runner reads to decide
between §5.8's `if failure.should_critique:` branch and the
default skip path. This section pins down how the signals
become the boolean.

### 7.1 The score

```python
def aggregate_score(signals: list[Signal]) -> float:
    base = sum(s.weight * s.confidence for s in signals if s.name != "sensitivity_high")
    return base
```

Each emitted signal contributes `weight * confidence`. For
deterministic heuristics, `confidence == 1.0`, so the
contribution is the weight from §3.1 / §3.2 / §3.3. For the
classifier-emitted signals, the contribution is the returned
`confidence` scaled by `classifier_signal_weight` (§6.3).

A turn with two cooperating signals — say `near_identical_user_msg`
(0.9) + `refusal` (0.6) — scores 1.5. A turn with a single
top-weight signal (`empty_response`, 1.0) scores 1.0. A turn
with nothing scores 0.

### 7.2 The threshold

```python
def should_critique(signals: list[Signal], scope: ScopeResult,
                    config: FailureConfig) -> bool:
    score = aggregate_score(signals)
    threshold = config.critique_threshold              # default 0.9

    if "sensitivity_high" in {s.name for s in signals}:
        threshold *= config.sensitivity_high_factor    # default 0.7

    if "prior_critic_fired" in {s.name for s in signals}:
        threshold *= config.prior_critic_factor        # default 0.85

    return score >= threshold
```

Two adjustments lower the threshold without changing the score:

- `sensitivity_high` (from scope) multiplies the threshold by
  `0.7`, so a sensitive turn fires the critic on weaker
  evidence (effective threshold 0.63 from the default 0.9).
- `prior_critic_fired` multiplies by `0.85`, so a conversation
  with recent critic interventions stays on a tighter leash.

When both apply, the multipliers compound: 0.9 × 0.7 × 0.85
≈ 0.535. A weak-but-real signal in a sensitive, already-flagged
conversation is enough.

### 7.3 Special cases

A handful of signals bypass the aggregator:

- `empty_response`, `loop_exhausted`, and `schema_failure_left`
  each carry weight 1.0 and trip the default threshold of 0.9
  on their own. The aggregator does not need a special branch
  for them; the weights already encode the rule.
- The classifier's `classifier_off_rails` (§6.3) does not get a
  multiplier from the dampener; it stacks like any other signal.
- A turn where the primary failed permanently
  (`metadata.error_type = "primary_failed"`, `005 §6.3`) does
  not enter the detector at all — the runner routes directly to
  the failure path. The detector is for primary turns that
  *completed* but look wrong.

### 7.4 Tunability

All thresholds, weights, and multipliers in this section live
under `host.config.failure.*` and can be overridden per agent
via `agent_context.user_overrides.failure.*`. The defaults
shipped with the host are the population defaults specified
inline; they are starting points, not invariants.

---

## 8. Cost model: how often does this fire?

The issue specifically asks: how often does the detector
trigger on a **non-failing** conversation? The answer determines
whether the critic budget is wasted.

This section gives the per-turn cost as a function of the
detector's two heuristic phases plus the optional classifier,
on a "non-failing" turn — one where the primary's response is
in fact correct and the conversation is not derailing.

### 8.1 Heuristic phases: always pay, always cheap

Every turn pays for both heuristic phases, by design. The cost
is:

| Phase            | Per-turn cost                                                                                                |
|------------------|--------------------------------------------------------------------------------------------------------------|
| Pre-primary      | ≤ 5 ms CPU; 1 indexed DB read (`recent_messages` is on the existing `idx_messages_conversation` from `003 §10`); 0 tokens; ≤ 1 embedding call at ≤ $0.00001. |
| Post-primary     | ≤ 1 ms CPU; 0 DB reads; 0 tokens.                                                                            |

Both phases are below the per-turn cost dashboard's noise
floor. They are effectively free.

### 8.2 Classifier fallback: pay only when gated

The classifier runs only when (a) heuristics are inconclusive
**and** (b) the turn is sensitive or the conversation has
prior critic interventions or the agent has explicitly opted
in (§6.2).

Expected fire rates on a non-failing population (estimates,
to be validated against telemetry post-MVP):

- **Default agent, default settings.** The agent's
  `user_overrides.failure.classifier_enabled = false`. The
  classifier never fires. The detector's cost is purely the
  heuristic phases.
- **Sensitive turns on an opted-in agent.** The fraction of
  turns with `scope.sensitivity == high` is small (the scope
  classifier sets it on roughly 5–10% of turns in early
  measurements, biased toward queries about people, money,
  health, or legal). Of those, the heuristic-inconclusive
  fraction is the band `[0.3, 0.7]`, which we estimate at
  another 10–20%. Joint fire rate: ~ 0.5–2% of all turns.
- **Conversations with prior critic interventions.** Once a
  critic has fired in a conversation,
  `prior_critic_fired` is set on every subsequent pre-primary
  pass within `lookback_messages`. Of those, the inconclusive
  band again gates by 10–20%. The conversation drops below
  this gate after enough fresh, uncomplicated turns.

The classifier_max_per_minute hard cap (§6.2) ensures the
detector cannot become a noisy neighbour: a sudden burst of
sensitive turns does not turn the detector into a major cost
center.

### 8.3 Critic fire rate on non-failing turns

The detector's purpose is to fire the critic on failing turns
and not fire it on non-failing turns. The metric that matters
is **false-positive rate**: the fraction of non-failing turns
on which the critic runs anyway.

Heuristic phase target: ≤ 3% false-positive rate on a
non-failing population. The weights in §3 and the threshold
of 0.9 in §7 are calibrated to this target, with the caveat
that the calibration is preliminary — the post-MVP plan is to
backfill weights against a labelled dataset.

Classifier phase target: ≤ 10% false-positive rate **on the
inconclusive band**. Since the classifier only sees the
inconclusive band, and that band is itself ≤ 20% of all turns
on opted-in agents, the overall false-positive contribution
from the classifier is ≤ 2% of all turns on opted-in agents
and 0% on default agents.

**End-to-end:** the critic should fire on at most ~ 5% of
non-failing turns under default settings. On a critic call
that costs roughly $0.01 (medium-class on ~ 1500 tokens), the
amortised per-turn critic cost from false positives is roughly
$0.0005. The detector's own classifier costs an additional
$0.0001-ish, amortised. Both fall below the noise floor; the
detector pays for itself on the **first** turn it actually
catches.

### 8.4 What about the failing population?

By construction, the detector should fire the critic on most
failing turns. We aim for ≥ 80% recall on the heuristic-only
path and ≥ 90% recall once the classifier is included. Recall
above 95% is anti-goal: chasing the last few percent forces
the false-positive rate up, and the critic itself is
expensive enough that a flood of unjustified runs would
outpace the value of the recall.

These targets are written here as the design intent. The
runner emits the data to evaluate them — every turn's
`metadata.failure` carries the signals and score, and the
user's eventual reaction (a follow-up message that itself
triggers a cross-turn signal, or an explicit thumb-down on
the assistant message) tells us whether the critic
intervention helped. Evaluation lives in a follow-up; the
hooks are here.

---

## 9. The `FailureSignal` data shape

The detector returns one `FailureSignal` per turn, regardless
of how many phases contributed.

```python
# eidan/runner/failure/types.py
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal, Sequence


@dataclass(frozen=True, slots=True)
class Signal:
    name:        str
    source:      Literal["heuristic", "classifier"]
    phase:       Literal["pre", "post"]
    weight:      float
    confidence:  float                        # [0, 1]
    evidence:    dict | None = None           # rule-specific (e.g. the
                                              # matched prefix; the
                                              # similarity score)


@dataclass(frozen=True, slots=True)
class FailureSignal:
    signals:           Sequence[Signal]
    score:             float                  # aggregated per §7.1
    threshold_used:    float                  # the per-turn threshold
                                              # after §7.2 adjustments
    should_critique:   bool                   # score >= threshold_used
    classifier_fired:  bool                   # whether §6 ran
    truncated_lookback: bool                  # the pre-primary phase
                                              # ran out of room
    rationale:         str | None = None      # classifier's rationale
                                              # if it ran; otherwise None
```

The DTO is persisted on **the assistant message** the primary
emitted, under `metadata.failure`. This means:

- The critic (`005 §5.8`) reads it from the message it is
  about to review.
- The cost dashboard joins on `messages.metadata.failure.score`
  to plot detector behaviour over time.
- A future evaluation harness loads the column wholesale.

The `signals[]` array preserves order: pre-primary signals
first (in catalogue order), then post-primary signals, then
classifier signals. This is purely for human readability —
order is not semantically significant.

The DTO's wire shape (for `004_SCHEMAS.md`) is reserved (§11);
until it stabilises, the in-process dataclass is the source of
truth.

---

## 10. Observability

Every turn writes `metadata.failure` on its primary assistant
message (the row from `005 §5.5`). Even turns where the score
is 0 and no signals fired: the field is set to an
"all clear" `FailureSignal` with empty `signals`. This makes
the column queryable without coalescing nulls.

When the classifier fires (§6), the spawn writes one
`llm_calls` row with `role = "failure_classifier"` (`003 §9`
constraint extension), attributing to the same `message_id` as
the primary call. The per-turn cost SQL in `005 §9` picks it
up without modification.

Structured logs emit:

- `failure.score`
- `failure.threshold_used`
- `failure.should_critique`
- `failure.signals` — JSON list of `(name, source, weight,
  confidence)`
- `failure.classifier_fired`
- `failure.classifier_judgement` (only when fired)

The per-turn debugger renders the `signals[]` array as a
bulleted list with the matched evidence underneath each
entry. A turn where the critic ran shows its rationale beneath
the signal list; a turn where the critic did not run shows the
score and threshold, so the operator can see how close it got.

### 10.1 Diagnostic SQL

A common question — "what signals fire most often on this
agent?" — is one query:

```sql
SELECT
  s ->> 'name'      AS signal_name,
  s ->> 'source'    AS source,
  count(*)          AS hits
FROM eidan.messages m,
     jsonb_array_elements(m.metadata #> '{failure,signals}') s
WHERE m.agent_id  = $1
  AND m.role      = 'assistant'
  AND m.created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY hits DESC;
```

The query is index-supported by the existing
`idx_messages_agent` (`003 §10`) plus the standard JSONB
expansion.

---

## 11. Reserved for later specs

Deliberately out of scope, to be specified in follow-ups:

- **Wire DTOs.** `agentic/FailureSignal.schema.json` and
  `agentic/FailureClassifierResult.schema.json` — owned by
  `004_SCHEMAS.md` once the in-process shape has stabilised.
  Until then, the dataclasses in §9 are authoritative and do
  not cross a process boundary.
- **Per-user calibration.** Adapting thresholds and lexicons
  to a specific user's idiom (some users always use caps, some
  always preface corrections with "actually"). The hooks
  (`agent_context.user_overrides.failure.*`) exist; the
  policy and the learning loop do not.
- **Per-agent labelled evaluation.** A harness that joins
  `metadata.failure` against ground-truth labels (user
  thumb-downs, follow-up dissatisfaction signals, manual
  review) and reports recall / false-positive rate per agent.
  The data is captured here; the harness is its own document.
- **Multilingual lexicons.** §3.4 specifies the locale lookup
  shape; the actual non-English lexicons (and the locale
  detection that picks them on a per-message basis when the
  user's `agent_context.locale` is unset) are reserved.
- **Adaptive classifier gating.** The §6.2 gate is static
  (sensitivity / prior-critic / opt-in). A future spec may
  let the runner *learn* when the classifier's verdict moved
  the critic decision and tighten the gate when the
  classifier rarely changes the outcome.
- **Detector-driven escalation outside the critic path.** A
  high-confidence pre-primary signal could short-circuit the
  primary call entirely (asking the user a clarifying question
  instead of guessing again). Today the only consumer of the
  pre-primary `FailureSignal` outside the detector is the
  sizer (§4); a clarifying-question early-out is reserved.
