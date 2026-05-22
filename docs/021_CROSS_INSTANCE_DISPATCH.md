# 021 — Cross-instance dispatch coordination

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Multi-instance backend),
`docs/006_BEHAVIOURS_TRIGGERS.md` (cron / schedule firings —
the load-bearing case in Phase 1),
`docs/007_PROVIDER_ABSTRACTION.md` (provider call surface, error
normalisation), `docs/010_COST_BUDGETING.md` (per-user budget gates,
shared cost accounting), `docs/005_AGENTIC_LOOP.md` (§5.5 primary
loop — the caller this layer sits in front of)

This document specifies the **coordination layer that prevents
duplicate work and runaway cost when more than one backend instance
is running against shared Postgres + shared provider credentials**.
The Phase 1 surface ships the load-bearing piece — advisory-lock
gating on every cron and schedule firing so two instances don't
double-fire the same behaviour every minute. The broader vocabulary
in §1 names what the full dispatch coordinator will look like once
provider-call gating + per-bucket concurrency caps land.

The pattern is borrowed from Gas Town's `scheduler.max_polecats`
capacity governor — but where they govern *agent dispatch*, this
layer governs *outbound provider calls* on shared credentials.

Phase 1 (this commit): cron + schedule firings gated by Postgres
advisory locks, keyed on `(behaviour_id, slot)`. Same primitive
used by `plugins/migrations.py` for cross-instance migration
serialisation. Implementation: `eidan_backend/behaviours/dispatch.py`,
the `_dispatch_under_lock` method.

Phase 2 (deferred to follow-up spec): the full dispatch coordinator —
capacity buckets, dispatch tokens, pressure signals, downsize-under-
pressure policy. The §1 vocabulary pins those terms now so the spec
can be written against a stable lexicon when it lands.

Out of scope:

- Adaptive cross-provider routing (Anthropic 429 → OpenAI fallback).
  The data lives in `llm_calls`; the routing policy is its own
  spec.
- In-process concurrency limits (single-instance asyncio semaphores).
  Those belong inside the provider adapter, not the cross-instance
  layer.
- Per-tool-call rate limiting. Tools are local; this layer only
  governs LLM calls and behaviour dispatch.

---

## 1. Vocabulary

| Term                    | Definition                                                                                                                                          |
|-------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Advisory lock**       | Postgres `pg_try_advisory_xact_lock(key1, key2)` — the in-Postgres primitive that gates work across instances. Released at transaction end.         |
| **Capacity bucket**     | A `(provider, model_class, scope)` tuple with a configured concurrency ceiling. Scope is per-key (default), per-user, or per-instance. Phase 2.     |
| **Coordinator**         | The logical component that issues dispatch tokens — advisory locks + an optional `eidan_dispatch.leases` table for observability. Phase 2.          |
| **Dispatch slot**       | The string the slot lock is keyed on. For cron: the minute. For schedule: the second. For provider calls: TBD with the Phase 2 coordinator.         |
| **Dispatch token**      | A short-lived lease, granted by the coordinator, authorising one outbound provider call. Acquired before the call, released after. Phase 2.        |
| **Lock prefix**         | The first int4 of a paired advisory-lock key. Eidan's behaviour dispatcher uses `0x49445350` ("IDSP") to namespace its locks away from any other.   |
| **Pressure**            | The signal a coordinator emits when buckets are saturated. Callers may defer, downsize, or escalate (`docs/022`). Phase 2.                          |

## 2. Phase 1 — cron + schedule advisory-lock gating

What's shipped today: every `cron:<expr>` and `schedule:<interval>`
behaviour firing inside `BehaviourDispatcher._dispatch_under_lock`
acquires a paired advisory lock keyed on
`(_LOCK_KEY_PREFIX, crc32(behaviour_id || '|' || slot))`. If the
lock can't be taken (some other instance is firing the same slot),
the dispatch is a silent no-op — the other instance is doing the
work. If acquired, the dispatch runs inside the same transaction so
the lock auto-releases on commit / rollback.

This is the multi-instance correctness primitive for behaviour
triggers. Two backends ticking against the same Postgres now collapse
to one firing per slot, not two. The in-process registry's
idempotency cache still protects against accidental double-dispatch
within a single instance.

### 2.1 Configuration

No env knobs. The lock is unconditional when the dispatcher receives
a pool at construction — `BehaviourDispatcher(registry, pool=pool)`.
The bootstrap wires the pool from `BootstrapResult`. Tests that don't
need cross-instance correctness can pass `pool=None` and the
dispatcher falls back to single-process mode.

### 2.2 Failure modes

| Mode                              | What happens                                                                                                          |
|-----------------------------------|------------------------------------------------------------------------------------------------------------------------|
| Lock not acquired (peer holds it) | Silent no-op. Peer fires. Correct.                                                                                    |
| Handler raises after lock taken   | Lock auto-releases on rollback; exception swallowed at the scheduler edge per `docs/001 §5.3`. Future DLQ surfaces it. |
| Pool unavailable                  | Dispatcher falls back to no-lock mode. Single-instance correctness intact.                                            |
| Postgres unreachable mid-firing   | The lock acquire raises; scheduler swallows; next tick retries.                                                       |

## 3. Phase 2 — dispatch coordinator (deferred)

The full coordinator is reserved for a follow-up spec. The shape:

```
runner thread / sentry tick / user turn
   │
   ▼
   coordinator.acquire(bucket="anthropic/sonnet", scope=per_key)
   │
   ▼ (block or denied)
   │
   ▼
   provider.start_call(...)
   │
   ▼
   coordinator.release(token)
```

Open design questions for that spec (the four that need a choice
before any code lands):

1. **Where does the lease live?** Postgres advisory locks are
   cheap but opaque to operators. A `dispatch_leases` table is
   inspectable but adds row churn. Working answer: both — advisory
   locks for the hot path, a row for observability + stale
   recovery.
2. **What does the caller do under pressure?** Three options:
   (a) block on a queue, (b) downsize to a cheaper model class via
   the sizer (`005 §5.3`), (c) escalate via `022`. Probably a
   per-trigger-type policy, not global.
3. **How does this interact with per-user budget gates?** A
   budget check that passes at lease time can still fail when the
   call actually runs; either a hold-and-commit pattern or a
   reconciliation step. Working answer: hold-and-commit, with the
   commit lazy at `llm_calls` write.
4. **Is the coordinator a leader-elected singleton, or stateless?**
   Stateless against shared Postgres is simpler but every instance
   pays the round-trip; leader-elected is faster but adds a single
   point of dispatch. Working answer: stateless. The advisory-lock
   path is already round-trip-on-every-firing; making it
   leader-elected adds failure modes without saving much.

## 4. Non-goals for the coordinator

- Cross-provider failover. One provider, one key class, one bucket.
  Add providers one at a time.
- Per-tool-call rate limiting. Tools are local.

## 5. Reserved for follow-ups

- The JSON Schema for lease grants / denials.
- The `eidan_dispatch.leases` table shape (column-by-column).
- The operator-facing CLI surface for inspecting current pressure
  (`eidan admin dispatch status`).
- The `dispatch_token` field on `eidan.llm_calls` for cross-referencing
  a call back to the lease that authorised it.
