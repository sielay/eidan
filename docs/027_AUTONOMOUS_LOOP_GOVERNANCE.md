# 027 — Autonomous loop governance ("enough")

Status: Draft
Owner: Core
Related: `docs/005_AGENTIC_LOOP.md` (§5.5 loop bounds, §5.7 failure
detector, §5.8 critic), `docs/009_FAILURE_DETECTION.md` (within- and
cross-turn signal set), `docs/010_COST_BUDGETING.md` (per-turn cost
gate), `docs/022_ESCALATION_ENVELOPE.md` (the stop-outcome surface),
`docs/006_BEHAVIOURS_TRIGGERS.md` (the triggers that start autonomous
loops), `docs/008_SUBAGENT_INVOCATION.md` (depth cap), `docs/SENTRY_FEATURE_SPEC.md`
(the load-bearing consumer)

This document specifies how an **autonomous loop** — a sequence or
tree of turns an agent drives without a human in the seat — decides
**when to stop**. It governs the *loop of turns*, sitting one level
above the per-turn governance that already exists:

- `005 §5.5` bounds a single turn's tool iterations (`_MAX_TOOL_ITERATIONS`).
- `009` fires the bicameral critic on suspect output, within and across
  turns.
- `008` caps subagent recursion depth (`MAX_SPAWN_DEPTH`).

None of those answer "this *loop* has gone on long enough" — the gap
this spec fills. The canonical consumer is the sentry loop
(`SENTRY_FEATURE_SPEC.md`): it may observe state, decide to research,
fan a few turns out, and at some point must decide it has **enough**
to act — or recognise it is **drilling a topic with no progress** (the
"keeps re-asking who am I" failure) and break out rather than burn
budget forever.

Out of scope:

- Per-turn governance (owned by `005`/`009`) — this layer composes
  with it, it does not replace it.
- The sentry idea backlog / loop cadence — a `SENTRY_FEATURE_SPEC`
  concern that *consumes* this governor.
- Embedding-based novelty scoring — deferred until a knowledge-embedding
  surface exists (§4 ships a deterministic detector first).

---

## 1. Vocabulary

| Term | Definition |
|------|------------|
| **Autonomous loop** | A goal-bearing process that drives ≥1 turn without a connected human, started by a behaviour trigger (`006`) or another loop. |
| **Step** | One unit of work in the loop — typically one turn (a system-initiated turn per `008`/#184, or a spawned subagent turn). |
| **Loop budget** | Cumulative caps across all steps of one loop: iterations, cost, wall-clock. Distinct from the per-turn cap in `010`. |
| **Sufficiency** | The judgment "given the goal, what's gathered is enough to act." Convened as a critic call (`005 §5.8`). |
| **No-progress** | The signal that recent steps are not advancing — repeated intent fingerprints or no new memory written. |
| **Stop verdict** | The governor's decision after each step: `Continue`, `StopSufficient`, `StopStuck`, or `StopBudget`. |

## 2. The governor

An autonomous loop runs under a **`LoopGovernor`** — an opt-in core
helper. User-initiated turns never use it; they are bounded by the
connected user. The governor carries the loop's `goal`, a `Budget`,
and a rolling `history` of step fingerprints, and after each step
returns a verdict:

| Verdict | Trigger | Outcome |
|---------|---------|---------|
| **Continue** | none of the below | run the next step |
| **StopSufficient** | sufficiency gate passes (§5) | proceed to the act phase |
| **StopStuck** | no-progress detector fires (§4) | escalate via `022`, then halt |
| **StopBudget** | a loop budget is exhausted (§6) | escalate via `022` with the partial result, then halt |

The governor does **not** itself act, escalate, or persist beyond
recording its verdict — the loop owner does, so the same governor
serves sentry, a fan-out reducer, or any future autonomous driver.

## 3. Relationship to existing governance

This layer is strictly additive:

- Each **step** is still a full turn governed by `005 §5.5` and
  inspected by `009`. A turn that `009` flags suspect convenes the
  critic *inside that turn*; that is orthogonal to the loop-level
  verdict.
- `009` already defines **cross-turn** signals. The no-progress
  detector in §4 is registered as a cross-turn signal in `009`'s
  framework rather than a parallel mechanism — it reuses the same
  signal plumbing and classifier-fallback budget discipline.
- `008`'s `MAX_SPAWN_DEPTH` caps the *depth* of the step tree; the
  loop budget (§6) caps its *total extent*. Both are hard stops.

## 4. No-progress detection (deterministic, slice 1)

Each step emits an **intent fingerprint** — a stable hash of its
normalised intent (e.g. the tool + canonicalised args it ran, or the
seed text of a system-initiated turn). The governor keeps a sliding
window of the last *K* fingerprints.

`StopStuck` fires when either:

- the last *K* fingerprints repeat (the "who am I" loop — the same
  intent recurring), or
- *N* consecutive steps write **zero new memory** (no new
  `knowledge` / `notes` / step result), i.e. the loop is spinning
  without accumulating anything.

`K` and `N` are configuration with conservative defaults. This is the
cross-turn extension of the `009 §5.7` "says-vs-did" philosophy: detect
activity that is not progress.

A later slice may replace the fingerprint with embedding-similarity
novelty once a knowledge-embedding surface lands; the verdict contract
is unchanged.

## 5. Sufficiency gate (critic, slice 2)

Convergence — "do I have enough to act?" — is a **critic** judgment,
the second voice of the bicameral pattern (`005 §5.8`). After a
gather/research step, the governor may convene the critic with the
loop's goal and the gathered context; the critic returns
`{ sufficient, missing[], confidence }`. `sufficient` → `StopSufficient`.

Because the critic surface is shared with `009`, slice 1 ships
**without** the sufficiency gate — a slice-1 loop relies on the agent
itself declaring done, bounded by no-progress (§4) and budget (§6).
Slice 2 adds the gate when the critic call site is wired for loop-level
use.

## 6. Loop budget (hard stops)

Three cumulative caps, summed across every step of the loop:

| Cap | Note |
|-----|------|
| `max_loop_iterations` | total steps. |
| `max_loop_cost_usd` | summed provider cost across all steps. **Distinct from `010`'s per-turn `max_turn_cost_usd`** — requires a loop-level accumulator, since each step is its own turn with its own per-turn cap. |
| `max_loop_wall_clock` | elapsed time. |

Any cap reached → `StopBudget`. These are unconditional, independent
of semantic convergence — the runaway-cost backstop.

## 7. Stop outcome → escalation

On `StopStuck` or `StopBudget`, the loop owner records an escalation
via the existing envelope (`022`): the agent is signalling "I could
not finish without help." Reason mapping:

| Verdict | `EscalationReason` |
|---------|--------------------|
| `StopBudget` (cost) | `over_budget` |
| `StopBudget` (capacity/wall-clock) | `over_capacity` |
| `StopStuck` | `no_progress` *(new reason — added to the `022` enum)* |

`StopSufficient` is **not** an escalation — the loop succeeded and
proceeds to act. Every stop reason and the partial result are
inspectable through the `022` inbox surface; nothing halts silently.

## 8. Phasing

1. **This design.**
2. **Slice 1** (no new LLM call): `LoopGovernor` + loop budget + the
   deterministic no-progress detector + `022` escalation on bail.
   Adds the `no_progress` reason to the `022` enum.
3. **Slice 2**: the sufficiency critic gate (§5), landing with the
   loop-level critic call site.

## 9. Open questions

- Where the `LoopGovernor` config defaults live (code default vs
  per-node operator override).
- Whether the no-progress window `K`/`N` should adapt per loop type
  (research loops tolerate more repetition than action loops).
- Whether `StopSufficient` with low critic confidence should act,
  escalate for confirmation, or shelve — likely a per-loop policy.
