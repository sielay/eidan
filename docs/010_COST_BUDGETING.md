# 010 — Cost budgeting and token tracking

Status: Draft

Owner: Core

Related: [ARCHITECTURE](./ARCHITECTURE.md) (Token tracking, Memory model), [MIGRATIONS](./002_MIGRATIONS.md) (§1 core / paid plugin layering, §5 RLS plugin), [MEMORY DDL](./003_MEMORY_DDL.md) (§9 `llm_calls`, §10 indexes), [AGENTIC LOOP](./005_AGENTIC_LOOP.md) (§1.1 eager persistence, §5.5 primary loop, §5.9 synthesis, §6.4 retry policy, §6.5 user-facing errors, §9 observability, §10 reserved per-turn quotas), [PROVIDER ABSTRACTION](./007_PROVIDER_ABSTRACTION.md) (§4 token accounting, §6.4 pricing), [SUBAGENT INVOCATION](./008_SUBAGENT_INVOCATION.md) (§3 spawn protocol)

This document specifies how Eidan **captures** every token its
agentic loop spends and how it **enforces** the operator's budget
caps against the captured ledger. Capture lives in core because
every deployment — single-user MVP, multi-user (paid baseline
bundle), and beyond — needs the same auditable spend log.
Enforcement also lives in core: a single-user MVP must still be
able to say "stop, this conversation has burned through its cap."
The richer analytics (per-user dashboards, period-over-period
drift, alerting) is a paid plugin that reads the same ledger;
this document fixes the contract that plugin consumes.

`005 §10` reserved "per-turn quotas and per-user cost ceilings"
to a follow-up; this is that follow-up. Where this document
contradicts the inline sketch in `005 §10`, this document wins.

Out of scope (deferred to follow-ups, see §11):

- The wire shape (DTO) for the per-turn cost envelope the UI
  receives — owned by `004_SCHEMAS.md` once the in-process shape
  has stabilised.
- Currency conversion. `cost_usd` is USD-only; multi-currency
  reporting is handled by the paid analytics plugin.
- Predictive forecasts ("at this rate you will run out on day
  X"). The data is in `llm_calls`; the model is not.
- Per-tool quotas (e.g. "the search tool can spend at most $N
  per day"). Today every cost is attributed to the LLM call it
  rode on; per-tool ledgering is its own spec.

---

## 1. Vocabulary

| Term                  | Meaning                                                                                                                                              |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Ledger**            | The `eidan.llm_calls` table (`003 §9`). Single source of truth for tokens and cost.                                                                  |
| **Capture**           | The act of writing a `llm_calls` row. Always synchronous, always before the runner forwards the call's result to the next step. See §3.              |
| **Cost**              | `eidan.llm_calls.cost_usd`, computed by the host at call time (`007 §6.4`) and persisted. Never recomputed on read.                                  |
| **Spend window**      | A SQL aggregate over the ledger bounded by a scope (`conversation_id`, `user_id`, `agent_id`) and an interval. The unit enforcement reads.            |
| **Cap**               | The configured ceiling on a spend window. Three core caps (per-turn, per-conversation, per-day) and one paid-plugin cap (per-user/per-period). See §4. |
| **Pre-call check**    | A budget check that runs **before** each `Provider.start_call` (`007 §2`) — pessimistic estimate vs. remaining cap. See §5.1.                         |
| **Soft cap**          | A cap that flags the turn and writes a `metadata.budget.exceeded` marker but does not refuse the call already in flight. The per-turn cap is soft.    |
| **Hard cap**          | A cap that refuses the next call before it is issued. The per-conversation, per-day, and per-user caps are hard.                                     |
| **Counter**           | A UI-rendered running total (per-turn cost, per-session cost). Derived from the ledger; the UI does not maintain it independently. See §6.            |
| **Analytics plugin**  | The paid plugin (`cost-analytics`, default name) that consumes the ledger to render dashboards. Reads only; never writes. See §7.                    |
| **Read-only role**    | The dedicated Postgres role the analytics plugin connects as. Owns `SELECT` on the read views and on `eidan.llm_calls`. See §7.4.                    |

---

## 2. The `llm_calls` row is the single source of truth

`003 §9` already defines the row. This section pins the contract
the budgeting code relies on, so a reader of either document
knows which fields the enforcement and analytics paths consume
without re-reading the DDL.

### 2.1 The budget-critical columns

The columns the enforcement path **MUST** treat as canonical:

| Column                  | Source                                              | Used by                                              |
|-------------------------|-----------------------------------------------------|-------------------------------------------------------|
| `user_id`               | The owner of the parent turn.                       | Per-user cap (paid plugin, §4.4); user-scoped dashboards. |
| `conversation_id`       | The conversation the call belongs to.               | Per-conversation cap (§4.2).                          |
| `message_id`            | The anchor message — typically the inbound user message (`005 §5.1`). | Per-turn rollup (§8.1) and the per-turn cap (§4.1).   |
| `agent_id`              | The agent that owns the conversation.               | Per-agent monthly cap (§4.5); agent-scoped analytics. |
| `role`                  | One of the closed `llm_calls_role_chk` values (`003 §9`, `005 §7`). | Filtering cost dashboards by purpose (primary vs. helper). |
| `input_tokens`          | Adapter-reported (`007 §4.1`).                      | Audit; reconciling cost.                              |
| `output_tokens`         | Adapter-reported.                                   | Same.                                                 |
| `cache_read_tokens`     | Adapter-reported (`007 §5.3`).                      | Cache-hit dashboards; pricing.                        |
| `cache_creation_tokens` | Adapter-reported.                                   | Same.                                                 |
| `cost_usd`              | Computed at call time by the runner (`007 §6.4`).   | **The** field every cap aggregates on.                |
| `started_at`            | Wall-clock start of the upstream call.              | Time-bucketing daily / monthly aggregates.            |
| `created_at`            | DB-side `now()`.                                    | Used by hot indexes (`003 §10`); tie-broken with `started_at`. |
| `error_type`            | Typed exception class name (`007 §8`).              | Excluded from "spent successfully" rollups; still counted in raw cost (errors that streamed cost real money). |

Three rules follow from this.

**Cost is computed once, stored, and never recomputed on read.**
The price table (`007 §6.4`) can change between deployments; the
row's `cost_usd` is frozen at its row's pricing. The analytics
plugin never multiplies tokens by a current price — it sums
`cost_usd`. *(Revisited by the proposed §12: the frozen value is
retained for billing and enforcement, with recomputation added for
analysis. Until §12 lands, frozen is the only behaviour.)*

**Failed calls are still rows.** `005 §6.5` is explicit: every
attempted call writes a row, populated with whatever tokens did
flow (typically `0`, occasionally non-zero if a stream began
before the failure). Enforcement aggregates over rows
regardless of `error_type`. The operator is billed for what the
provider charged, not for what the runner intended to do.

**Retries are separate rows.** `005 §6.4` already states this:
each retry attempt writes its own `llm_calls` row, linked via
`metadata.retry_of`. The enforcement aggregator includes every
retry. A flaky upstream that retries three times has billed three
calls and the cap reflects that.

**Plugin-emitted rows are first-class.** A plugin's tool handler
that invokes an LLM (or any token-billed upstream) **outside**
the host's in-process `Provider` abstraction — shelling out to a
vendor CLI, hitting a paid HTTP API with the vendor's own SDK,
calling an embedding endpoint directly — lands its spend on the
same `eidan.llm_calls` table via `ctx.report_llm_call(...)` (see
§3.1 row 5 and the writer surface pinned in
`apps/backend/eidan_backend/tools.py:ToolContext`). The row
carries the same (user_id, conversation_id, message_id,
agent_id) anchors as the calling turn's in-loop rows, the same
four token axes, and a `cost_usd` computed by the host's price
table — the SINGLE source of truth, including `§3.4` env-var
overrides. Caps (`§4`) and the analytics plugin (`§7`) aggregate
plugin-emitted rows uniformly with in-loop rows. Per-tool
ledgering (one `tool_calls` table, per-tool caps) is a separate
follow-up (see `intro`'s out-of-scope list); today every paid
upstream a plugin invokes lands in `llm_calls` and inherits the
existing caps.

### 2.2 What the row does NOT carry

The following are deliberately **not** columns on `llm_calls`:

- **A per-user / per-agent monthly counter.** Aggregates are
  queries, not denormalised columns. The DB pays the cost of
  `SUM(cost_usd) WHERE …` on every cap check; that cost is
  bounded by the indexes in §8.
- **A "remaining budget" field.** Remaining budget is `cap −
  SUM(spent)`; spelling it out as a column would invite races
  between two concurrent turns.
- **A flag for "the turn that emitted this row exceeded its
  cap."** That marker lives on `messages.metadata.budget`,
  attributed to the anchor message, so a single per-turn marker
  covers many ledger rows.

The split is the same one `003` already uses for `messages` vs
`llm_calls`: the ledger is immutable audit; the marker on
`messages.metadata` is the turn's commentary on it.

---

## 3. Write timing: eager persistence applies

Capture obeys the project's eager-persistence (EP) rule from
`005 §1.1`. For `llm_calls` the rule reads:

> Every `llm_calls` row is committed **before** its result is
> forwarded to the next step that depends on it.

In the primary loop (`005 §5.5`) this means:

```
provider.start_call(...) ──▶ stream completes
                              │
                              ▼
                       INSERT eidan.llm_calls   ◀── commit
                              │
                              ▼
                  forward result to next step (tool exec,
                  next loop iteration, failure detector,
                  synthesis, …)
```

The runner does **not** do this with an outbox or a deferred
writer. EP is synchronous; if the worker dies between the
provider call returning and the next step starting, the next
process can see the row and resume, or surface a failure,
without re-issuing the upstream call (and re-paying for it).

### 3.1 The five moments a row is written

| Trigger                              | Write site                                   | Notes                                                                  |
|--------------------------------------|----------------------------------------------|------------------------------------------------------------------------|
| Stream completed, response assembled | Runner step that owns the call (`005 §5.5`, `008 §3.3`'s helper / turn dispatchers) | Normal path. Tokens, cost, latency are all known.                       |
| Stream aborted mid-message           | Same site, in the `except`/`finally` branch  | Whatever tokens flowed get accounted (`007 §4.4`); `error_type` set.   |
| Typed `ProviderError` (`007 §8.1`)   | Same site, in the `except` branch            | `output_tokens=0` unless a stream had begun; `latency_ms` is time-to-failure. |
| Per-turn deadline trips mid-call     | The cancellation hook in `005 §6.2`           | Row written before the runner returns the friendly timeout response.   |
| Plugin tool calls a billed upstream **outside** the `Provider` abstraction (vendor CLI, paid HTTP API, embedding SDK) | Plugin handler invokes `await ctx.report_llm_call(...)` (`apps/backend/eidan_backend/tools.py:ToolContext`) | Same row shape. Anchors (`user_id`, `conversation_id`, `message_id`, `agent_id`) inherited from the calling turn. Host computes `cost_usd` from its price table (`§3.4`) — the plugin never multiplies tokens by a price itself. EP holds (the INSERT commits before the writer returns). Failed plugin calls still write a row with `error_type` set (§2.1 "Failed calls are still rows" applies). |

The catch-all rule: a row is written before any user-visible
response that depends on the call, **and** before any subsequent
LLM call uses the result of this one. EP does not allow a
"hot in-memory cache" of provider results that has not yet hit
the DB to drive the next step. Row 5 is the plugin-emitted
write site (`002 §1.1`'s extension point): the host snapshots
the calling turn's anchors into a closure at the top of
`run_turn`, hands it to the tool handler via
`ToolContext.report_llm_call`, and the plugin invokes it once
per upstream call it actually issues. A plugin that loops
internally over several embeddings writes several rows — never
aggregates, never updates an existing row's `cost_usd`
(`§2.1` "frozen on the row").

### 3.2 Why EP and budgeting are inseparable

A per-conversation cap that read in-memory state would
under-count a partial run. A per-day cap that read in-memory
state would miss a worker that crashed and got restarted. The
budget check **reads `llm_calls`** in §5; that read is honest
only because EP commits every prior call before the check
fires. Skipping EP for a "cheap" call would leak that call out
of the cap; there are no cheap calls in this respect.

### 3.3 Cost is computed at write time

`007 §6.4` already states pricing is frozen on the row. The
runner's `_envelope` helper composes the cost from
`ProviderInfo.pricing` × the adapter's four-column token report
**before** the INSERT. No row is written with `cost_usd = 0`
just because the price table was not consulted; the
not-yet-priced model raises `ProviderCapabilityError` at
`start_call` time, which is also captured (with whatever
information is available, `cost_usd = 0` in that single case)
so the operator sees the misconfiguration in the dashboard.

### 3.4 Per-model rate-table overrides via env vars

The default rate table baked into each provider adapter is what
the public price list says. An operator with negotiated rates —
or anyone routing through a proxy that charges differently —
overrides any of the four token axes per model via the process
environment:

```
EIDAN_PRICE_<MODEL>_INPUT
EIDAN_PRICE_<MODEL>_OUTPUT
EIDAN_PRICE_<MODEL>_CACHE_READ
EIDAN_PRICE_<MODEL>_CACHE_CREATION
```

Values are floats in **USD per 1M tokens** (the same unit the
default table uses). `<MODEL>` is the model id upper-cased with
every non-alphanumeric character collapsed to `_`:

| Model id                  | Env-var stem                  |
|---------------------------|-------------------------------|
| `claude-opus-4-7`         | `EIDAN_PRICE_CLAUDE_OPUS_4_7` |
| `claude-sonnet-4-6`       | `EIDAN_PRICE_CLAUDE_SONNET_4_6` |
| `claude-haiku-4-5-20251001` | `EIDAN_PRICE_CLAUDE_HAIKU_4_5_20251001` |

Overrides are read at call time, not at adapter init, so the
same process can be reconfigured without a restart for a
follow-up call (this matters for soak tests). A malformed value
(non-float) is ignored and the default for that axis is used,
with a structured log entry; the call is **never** failed by a
bad override — at worst the operator pays the public rate they
were trying to escape.

Because `cost_usd` is frozen on the `llm_calls` row (§2.1, §3.3),
changing an override mid-stream does not retroactively re-price
historical rows. The override only affects future calls. This is
the same property `007 §6.4` already pins for the underlying
price table; the env-var hook is a thin overlay on the same
table.

Out of scope here: a YAML / TOML rate file. The env-var hook is
enough for the rates an operator can realistically have on hand
during onboarding; a structured rate file is a follow-up if and
when operators ship many models at once.

---

## 4. Budget configuration shape

Caps live in three places, in increasing scope:

1. **Host defaults** — shipped with the host, in
   `host.config.budget.*`. Apply to every conversation when no
   more specific override exists.
2. **Per-agent overrides** — under
   `agent_context.user_overrides.budget.*` (`003 §7`). Apply to
   every conversation owned by that agent.
3. **Per-user caps (paid plugin only)** — rows in a paid-plugin-
   owned `eidan.user_budgets` table (§4.6). Apply to every
   conversation belonging to that user, across agents.

The runner reads all three and takes the **minimum** of the
applicable caps at check time. A user-level cap of $5/day can
never be made looser by a per-agent override of $50/day.

Every cap aggregates `SUM(cost_usd) FROM eidan.llm_calls` filtered
on the appropriate anchor (`message_id`, `conversation_id`,
`user_id`, `agent_id`). The aggregate is over the table — not
over rows tagged with a particular `role` — so the four
in-loop roles, the new `plugin_tool` role (§2.1's
plugin-emitted writes), `subagent` rows from `008`, and every
classifier/critic row all participate in the same cap. The
budgeting code path treats "the row exists in `llm_calls` with
a non-zero `cost_usd`" as the cost-bearing event; the writer
that emitted it is unrelated to enforcement.

### 4.1 Per-turn cap

```python
budget.per_turn_usd: float | None     # default 0.50
```

Soft cap. The runner is permitted to **complete the turn in
flight** even if it crosses the cap mid-loop, because aborting
a turn mid-primary-loop produces a worse user experience than
overshooting one budget by a fraction of a cent. The aggregator
in `005 §5.7` raises a `budget_exceeded` failure signal (an
additive entry to `009 §3.1`) when the turn's running total
crosses the cap; the synthesis step (`005 §5.9`) emits a
"this turn was over its budget" hint in the result envelope
for the UI to render.

Concretely, between iterations of the primary loop
(`005 §5.5`), the runner reads the running total via §8.1 and:

- If running total < cap: continue normally.
- If running total ≥ cap but ≤ cap × `per_turn_hard_factor`
  (default 1.5): emit the failure signal, continue the current
  iteration, but pass `tools=[]` and a "wrap up now" addendum
  to the system prompt on the *next* iteration so the model
  closes out.
- If running total > cap × `per_turn_hard_factor`: abort the
  loop, return whatever the last assistant message was, and
  let `005 §6.5` render the timeout-style response.

The `per_turn_hard_factor` exists because the cheapest fix for
an unreasonable per-turn cap is to widen the soft window
multiplicatively; operators rarely want a hard cliff at the
default and an absolute cliff at 1.5× is enough headroom for
the long tail.

### 4.2 Per-conversation cap

```python
budget.per_conversation_usd: float | None  # default 10.00
```

Hard cap. Aggregates `cost_usd` for all rows where
`conversation_id = $1`, with no time bound. A conversation that
has burned through its cap stops accepting new turns: the
pre-flight check in §5.1 refuses the next user message before
the scope classifier runs. The user sees a system-emitted
assistant message keyed by reason `budget.conversation_exhausted`
(`005 §6.5`).

The user may start a new conversation; the cap is on the
conversation, not on the user.

### 4.3 Per-day cap

```python
budget.per_day_usd: float | None     # default 5.00
```

Hard cap. Rolling 24-hour window: `SUM(cost_usd) WHERE
user_id = $1 AND started_at > now() - interval '24 hours'`.
The window is "trailing 24h," not "since midnight UTC,"
because midnight-UTC resets create a visible cliff in the
dashboards and a calendar-day rule is harder to reason about
across timezones.

When the per-day cap is hit, the pre-flight check refuses the
next user message; the synthesis layer emits a system message
with `budget.day_exhausted` and includes the time at which the
oldest charged call rolls off the window (the next moment
spend will be permitted).

### 4.4 Per-user cap (paid plugin)

Delivered by a paid plugin. In core, every deployment is
single-user (by the `002 §1` definition: core is the
single-tenant base). Per-user caps in a single-user deployment
are equivalent to per-day caps on the operator, which §4.3
already covers.

In multi-user deployments (paid baseline bundle installed),
where the operator hosts multiple users, per-user caps become
the load-bearing isolation guarantee: one user cannot spend
another user's budget. They live in `eidan.user_budgets` (§4.6),
are read via the same `SUM(cost_usd) WHERE user_id = $1 AND
started_at > now() - $window`, and are enforced at the same §5
pre-flight check.

The runner code that enforces the cap is in **core** (the
check is the same shape); the **rows** that define the cap
are owned by the paid plugin. A core-only deployment finds no
`user_budgets` rows and falls through to per-day defaults.

### 4.5 Per-agent monthly cap

```python
budget.per_agent_month_usd: float | None  # default None (off)
```

Optional hard cap. Aggregates `cost_usd` for all rows where
`agent_id = $1` over the trailing 30 days. Useful for capping
an experimental agent's blast radius without affecting other
agents on the same conversation. Off by default; operators
opt in when they ship a new agent and want a budgetary fence
around it.

*(Two further scopes — per-node and per-model — are proposed in
§13, along with a `downgrade` decision tier between the soft and
hard caps.)*

### 4.6 Where the caps physically live

```python
# eidan/runner/budget/config.py
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BudgetConfig:
    """Resolved caps for a (user, agent, conversation) tuple.

    Built once per turn by `resolve_budget_config(ctx)`, which
    takes the minimum across host defaults, agent overrides,
    and (if PRO) user_budgets rows.
    """
    per_turn_usd:           float | None  # soft;   §4.1
    per_turn_hard_factor:   float         # default 1.5
    per_conversation_usd:   float | None  # hard;   §4.2
    per_day_usd:            float | None  # hard;   §4.3
    per_user_usd:           float | None  # hard;   §4.4 (PRO)
    per_user_window:        str           # default "24h"
    per_agent_month_usd:    float | None  # hard;   §4.5

    # Soft-cap response shaping (§4.1)
    wrap_up_addendum:       str           # appended to system prompt
                                          # when entering wrap-up mode
```

Host defaults (config file):

```yaml
budget:
  per_turn_usd:         0.50
  per_turn_hard_factor: 1.5
  per_conversation_usd: 10.00
  per_day_usd:          5.00
  per_agent_month_usd:  null
  wrap_up_addendum: |
    You are over the per-turn budget. Stop calling tools and
    summarise what you have so far in plain text.
```

Per-agent overrides (`agent_context.user_overrides.budget`):

```jsonc
{
  "budget": {
    "per_turn_usd":         1.00,
    "per_conversation_usd": 25.00
  }
}
```

PRO per-user caps live in a PRO-only table that core does not
read at apply time. The migration ships in the universal paid
baseline sibling bundle, not in this repo:

```sql
-- plugins/<paid-baseline>/migrations/<UTC>_user_budgets.py
-- (lives in the universal paid baseline sibling bundle; not in core)
CREATE TABLE eidan.user_budgets (
  user_id              uuid        PRIMARY KEY
                                   REFERENCES eidan.users(id)
                                   ON DELETE CASCADE,
  per_day_usd          numeric(12, 4),
  per_window_usd       numeric(12, 4),
  window               interval    NOT NULL DEFAULT interval '24 hours',
  per_month_usd        numeric(12, 4),
  per_conversation_usd numeric(12, 4),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
```

Per `002 §5`, the PRO migration tier owns the RLS policies that
isolate one user's row from another. The core enforcement reads
this table opportunistically: if it exists (PRO installed) it
joins; if it does not (core only) it skips. A `LEFT JOIN` on a
`to_regclass` check is the cheapest way to express this without
two code paths.

### 4.7 Resolution order

```python
def resolve_budget_config(ctx: TurnContext) -> BudgetConfig:
    # 1. Host defaults
    cfg = ctx.host.config.budget.copy()

    # 2. Per-agent overrides
    if agent := ctx.convo.agent:
        cfg = cfg.merge(agent.user_overrides.get("budget", {}))

    # 3. Per-user caps (PRO; falls through to None on core)
    if row := ctx.pro.user_budget(ctx.convo.user_id):
        cfg = cfg.merge_minimum({
            "per_user_usd":         row.per_window_usd,
            "per_user_window":      row.window,
            "per_day_usd":          row.per_day_usd,
            "per_conversation_usd": row.per_conversation_usd,
        })

    return cfg
```

`merge` lets per-agent **loosen or tighten** vs. host. `merge_minimum`
(used for PRO) only **tightens** — a PRO user-cap can never be
loosened by an agent override.

---

## 5. Enforcement: pre-call check, not per-step check

The decision: **pre-call**. Every `Provider.start_call`
(`007 §2`) is preceded by a budget check. The check is cheap
(one indexed `SUM`); the alternative (per-step) is both coarser
and harder to reason about.

### 5.1 Why pre-call and not per-step

The plausible alternatives:

| Granularity      | Description                                                                 | Why it's wrong                                                                                                                                                                                                                                                                                              |
|------------------|-----------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Per-turn boundary | Check budget once, before step ① of `005 §3`.                              | A turn is at most one user message, but one turn can issue dozens of provider calls inside the primary loop (`005 §5.5`). A turn that starts under-budget can finish wildly over-budget. The check would over-shoot the cap by 10×–100× on tool-storm turns.                                                  |
| Per-step boundary | Check budget at every step transition in `005 §3` (③ → ④ → ⑤ → …).         | Better, but the primary step is the cost center and the primary step contains the loop. Checking only on entry to ⑥ still over-shoots.                                                                                                                                                                       |
| Per-call boundary | Check before every `Provider.start_call`, **including inside the loop**.   | Correct. The cap is enforced at the granularity of the thing that costs money, which is the upstream call. The check itself is one indexed aggregate against `llm_calls` and is dominated by network latency on every realistic deployment.                                                                  |
| Per-token        | Stream-tap each token and cancel mid-response on cap-hit.                  | Possible (the streaming protocol allows mid-stream cancellation) but the user-visible result is a half-message, and the provider charges for the tokens already emitted. The savings vs. per-call are bounded by one call's worth of overshoot, which is not worth the UX cost. Reserved as a future opt-in. |

Pre-call wins on three axes:

- **Cheap.** One aggregate query per call; index-supported.
- **Correct.** Caps at the granularity of the cost itself.
- **Composes.** The same check runs for primary calls, scope
  classifier calls, summariser calls, critic calls, agent
  router calls, and subagent spawns. One code path covers every
  role in `005 §1` and `008 §3`.

Plugin-emitted rows (`§2.1`, `§3.1` row 5) participate in the
check by virtue of landing in `eidan.llm_calls` before the next
in-loop pre-call check runs. The check itself does not need
a plugin-specific code path: it aggregates over the whole
ledger and the plugin's row contributes its `cost_usd` to the
same spend window as the next in-loop call's pre-flight check
will see. A plugin tool that overshoots the per-turn cap in a
single fan-out lands the spend on the ledger; the very next
iteration of the primary loop sees the higher running total and
the soft/hard cap (§4.1, §5.4) trips as if the spend had been
billed to a primary call.

### 5.2 The check

```python
async def check_budget_pre_call(
    ctx:    TurnContext,
    role:   str,                     # llm_calls.role
    estimate: CostEstimate,          # see §5.3
) -> BudgetDecision:
    """Returns a decision: allow, deny, or wrap_up.

    Reads three (PRO: four) aggregates against eidan.llm_calls.
    Each aggregate is index-supported (§8).
    """
    cfg = ctx.budget                       # resolved per §4.7
    spent = await ctx.repo.budget_spend(
        conversation_id = ctx.convo.id,
        user_id         = ctx.user_msg.user_id,
        agent_id        = ctx.convo.agent_id,
        message_id      = ctx.user_msg.id,         # turn anchor
    )
    projected_turn = spent.turn + estimate.upper_bound_usd

    # Soft cap (per-turn) — wrap-up, do not deny
    if cfg.per_turn_usd and projected_turn > cfg.per_turn_usd:
        if projected_turn > cfg.per_turn_usd * cfg.per_turn_hard_factor:
            return BudgetDecision.deny(reason="turn_hard_cap")
        return BudgetDecision.wrap_up(reason="turn_soft_cap")

    # Hard caps — deny
    if cfg.per_conversation_usd and \
       spent.conversation + estimate.upper_bound_usd > cfg.per_conversation_usd:
        return BudgetDecision.deny(reason="conversation_cap")
    if cfg.per_day_usd and \
       spent.day + estimate.upper_bound_usd > cfg.per_day_usd:
        return BudgetDecision.deny(reason="day_cap")
    if cfg.per_user_usd and \
       spent.user_window + estimate.upper_bound_usd > cfg.per_user_usd:
        return BudgetDecision.deny(reason="user_cap")
    if cfg.per_agent_month_usd and \
       spent.agent_month + estimate.upper_bound_usd > cfg.per_agent_month_usd:
        return BudgetDecision.deny(reason="agent_month_cap")

    return BudgetDecision.allow()
```

The check is called from exactly one place: the spawn primitive
(`008 §3.3`). The runner does not duplicate it; the primary
loop, every helper, and every subagent turn all route through
spawn, and spawn runs the check before each `Provider.start_call`.
This is the same property §5.1's last bullet calls out — one
enforcement code path for every role.

### 5.3 The cost estimate

Pre-call, the actual `cost_usd` of the upcoming call is unknown.
The check uses a pessimistic upper bound:

```python
@dataclass(frozen=True, slots=True)
class CostEstimate:
    input_tokens:           int      # from Provider.count_input_tokens
    estimate_accuracy:      str      # "exact" | "heuristic"  (007 §4.2)
    max_output_tokens:      int      # ModelInfo.max_output_tokens
                                      # — assume the worst-case completion
    pricing:                Pricing  # ModelInfo.pricing
    upper_bound_usd:        float    # derived (§5.3)
```

The derivation:

```
upper_bound_usd =
    input_tokens   × pricing.input_per_mtok           / 1e6
  + max_output_tokens × pricing.output_per_mtok      / 1e6
  + (cache_creation_estimate × pricing.cache_creation_per_mtok / 1e6
     if cache hints are set)
```

This deliberately overestimates: `max_output_tokens` is the
ceiling the model is allowed to emit, not the median. A
conversation right at the cap will be denied earlier than
strictly necessary. The alternative — using a *median* output
estimate — admits overshoot, which would defeat the cap. The
pessimistic bound is the right error to make.

Heuristic estimates (`007 §4.3`) inflate `input_tokens` by 1.2×
inside the check, since the heuristic is a 4-chars-per-token
fallback and is empirically low on tool-heavy prompts.

### 5.4 What the runner does with the decision

The three variants below (`allow` / `wrap_up` / `deny`) are the
shipped set. The proposed §13 adds a fourth, `downgrade`, between
`allow` and `wrap_up`, that substitutes a cheaper model instead of
refusing the call.

```python
match decision:
    case BudgetDecision.allow():
        await provider.start_call(...)        # normal path

    case BudgetDecision.wrap_up(reason):
        # §4.1 soft cap. Append the wrap-up addendum to system,
        # set tools=[] for the next iteration, continue.
        ctx.set_wrap_up(reason)
        await provider.start_call(..., system=cfg.wrap_up_addendum, tools=[])

    case BudgetDecision.deny(reason):
        # Write a budget-deny row to llm_calls for audit (no HTTP call
        # made; cost_usd = 0, latency_ms = 0, error_type = "BudgetDenied").
        await ctx.repo.append_llm_call(
            role        = role,
            error       = f"budget cap: {reason}",
            error_type  = "BudgetDenied",
            **zero_accounting(),
        )
        return SpawnResult(ok=False, error=SpawnBudgetDeniedError(reason=reason))
```

`SpawnBudgetDeniedError` is a new non-retryable entry in
`008 §6.3`'s closed `SpawnError` hierarchy:

```python
class SpawnBudgetDeniedError(SpawnError):
    code = "budget_denied"
    retryable = False
    # reason ∈ {"turn_hard_cap", "conversation_cap",
    #          "day_cap", "user_cap", "agent_month_cap"}
```

It is returned (not raised) by spawn, the same as every other
spawn error per `008 §3.2`. Unlike the rest of `008 §6.3`'s
conventional defaults (proceed with a fallback), the budget
denial **propagates**: the run_turn step that sees a spawn
returning `SpawnBudgetDeniedError` does not fall back, it
short-circuits.

The runner translates it at the step boundary:

- **At the turn entry** (the implicit first pre-call before
  the scope classifier runs): the runner skips the rest of the
  turn and emits a system-emitted assistant message keyed by
  the deny reason. `005 §6.5`'s shape is reused; the cost
  dashboard reads a single "budget-rejected turn" row plus the
  audit row from the deny.
- **Mid-loop** (a later iteration's check fails after earlier
  calls succeeded): the runner exits the loop, keeps the last
  assistant message, and synthesis appends a wrap-up sentence
  explaining the cap was hit. The user sees what was already
  generated, plus an explicit "I stopped here because…" note.

`SpawnBudgetDeniedError` is the **only** spawn error that
overrides `008 §6.3`'s "spawn failures degrade gracefully"
pattern. The override is justified: every other spawn error
trades reduced quality for completion; a budget denial is the
operator's explicit "do not spend more," and falling back
would defeat the cap.

### 5.5 Race and atomicity

Two concurrent turns on the **same conversation** racing the
per-conversation cap can both pass the pre-call check at the
same time (each sees the other's spend as not yet committed),
both issue calls, and the conversation's total ends slightly
over cap. This is accepted. The justification:

- The per-conversation cap is operator-set with headroom. A
  default of $10 is not chosen because $10.20 is catastrophic.
- A read-modify-write under SERIALIZABLE on the aggregate would
  cost more than the calls themselves at high concurrency.
- The follow-up turn that actually tries to spend more **after**
  both committed will see the higher total and be denied. The
  race never causes runaway spend, only one extra call.

The same logic applies across users for the per-day cap, and
across conversations for the per-user PRO cap. The cap is a
ceiling with a slip-tolerance bounded by one call per concurrent
spawn, which is the smallest unit the runner accounts at.

If an operator needs a strict ceiling, the PRO analytics plugin
exposes a "hard-stop on cap" toggle in §7 that wraps the check
in `SELECT … FOR UPDATE` on a synthesised counter row; that path
is off by default in core because the cost is real and the
benefit is small.

### 5.6 What does NOT trigger a check

- **Local tool execution** (`005 §5.5` tool block). Tools are
  not LLM calls. If a tool itself wraps a provider call (a
  search tool with embedded re-ranking) the tool's own spawn
  invocation runs the check; the outer tool execution does not
  double-count.
- **Cache-only hits.** A `count_input_tokens` cached lookup
  (`007 §4.2`) does not generate a `llm_calls` row and does
  not run a check.
- **Synthesis** (`005 §5.9`). Deterministic packaging; no
  provider call.
- **The check itself.** No, it is not recursive.

---

## 6. UI counter hooks

The UI surfaces three running totals: **turn cost**,
**session cost**, and **rolling day cost**. All three are
read from the ledger; the UI never owns the count.

### 6.1 Per-turn cost in the synthesis envelope

`005 §5.9` already lists "accumulated cost from `llm_calls` rows
belonging to this `user_msg.id`" as a field on the synthesis
bundle. This document fixes the shape:

```ts
type TurnCost = {
  cost_usd:          number;          // SUM(cost_usd) for this turn
  input_tokens:      number;
  output_tokens:     number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cap_state: {
    kind:    "ok" | "wrap_up" | "denied";
    reason:  string | null;
    per_turn_usd:         number | null;  // null = no cap
    per_conversation_usd: number | null;
    per_day_usd:          number | null;
  };
};
```

The synthesis step (`005 §5.9`) writes this to the result
envelope; the UI renders it next to the assistant message. The
`cap_state.kind` field drives the rendering: `ok` shows a
discreet `$0.04` chip; `wrap_up` shows a yellow badge; `denied`
shows the deny reason as part of the system-emitted message
itself.

### 6.2 Streaming counter

While the primary call is streaming, the UI displays a running
input-token count (the pre-call estimate, fixed for the
duration of the stream) and an output-token tick that updates
as content arrives. The tick is **derived from the streamed
content length**, not from provider-side usage events (most
providers emit `usage` only on `message_stop`). The estimate
is corrected to the authoritative value on stream-end:

```
during stream:     out ≈ len(content_so_far) / 4    (rough; UI hint only)
on stream-end:     out  = accounting().output_tokens (authoritative)
```

This is purely cosmetic. The cap check (§5) never reads it; it
reads only committed `llm_calls` rows.

### 6.3 Session and rolling-day counters

The UI's conversation header carries a session counter
(`SUM(cost_usd) WHERE conversation_id = $1`) and the user's
rolling-day counter (`SUM(cost_usd) WHERE user_id = $1 AND
started_at > now() - interval '24 hours'`). Both refresh:

- On every turn's synthesis bundle (the bundle carries fresh
  values).
- On a websocket push from the backend when a background spawn
  (subagent, `005 §5.10`) commits a row. The push payload is
  the new aggregate; the UI replaces, does not add.

The "Day" counter colour-codes against `per_day_usd`:

- ≤ 80% of cap: neutral.
- 80%–100%: warning.
- > 100%: error; turns are being denied.

The 80% threshold is the host's `budget.warn_fraction` (default
0.8), tunable per agent under `user_overrides.budget.warn_fraction`.

### 6.4 Where the UI gets the numbers

The UI does not query Postgres directly. The backend exposes
two read endpoints, both backed by the views in §7.1:

```
GET /api/budget/turn?message_id={anchor}
GET /api/budget/session?conversation_id={id}&user_id={id}
```

Both endpoints are authenticated to the user that owns the
conversation. In a PRO multi-user deployment the same endpoint
runs against the user's RLS-scoped session (`002 §5`).

---

## 7. The PRO analytics plugin interface

The PRO `cost-analytics` plugin reads the ledger to render
dashboards (per-user spend, per-model spend, period-over-period
drift, cache-hit ratio, model-class distribution). This section
fixes the **shape** it consumes; the dashboard itself is the
plugin's own concern.

### 7.1 Read-only views (the preferred surface)

Core ships a set of read-only views designed so the analytics
plugin can build dashboards without joining against the raw
schema. Views are SQL `VIEW`s, not materialised — at MVP scale
the queries are cheap and freshness matters more than
amortising. A future spec may add materialisation when the
shape stabilises.

The views live in the `eidan` schema, named `v_llm_*`, and
are owned by a **core** migration so the analytics plugin can
rely on them existing in any deployment:

| View                                | Purpose                                                                                          |
|-------------------------------------|---------------------------------------------------------------------------------------------------|
| `eidan.v_llm_cost_per_user_day`     | One row per (`user_id`, `day::date`). Aggregates: `cost_usd`, four token columns, call count.    |
| `eidan.v_llm_cost_per_conversation` | One row per `conversation_id`. Aggregates: same. Plus `started_at` of first call and last call.   |
| `eidan.v_llm_cost_per_agent_month`  | One row per (`agent_id`, `date_trunc('month', started_at)`). Same aggregates.                    |
| `eidan.v_llm_cost_per_model_day`    | One row per (`provider`, `model`, `day::date`). Aggregates plus avg `latency_ms`, error count.   |
| `eidan.v_llm_cache_hit_per_day`     | One row per (`user_id`, `day::date`). `cache_read_tokens / (input_tokens + cache_read_tokens)`. |
| `eidan.v_llm_errors_per_day`        | One row per (`user_id`, `day::date`, `error_type`). Count and summed lost cost.                  |

These views are the **stable contract** for the plugin. Their
column names and types do not change across core minor
versions. Adding a column is allowed; removing or renaming is
not without a deprecation window of one minor version
(`002 §5.3` already promises this for tables; this document
extends the promise to these views by name).

The plugin SHOULD prefer these views over the raw `llm_calls`
table for anything it surfaces in a dashboard, because:

- The views absorb future column renames or splits in
  `llm_calls`.
- PRO RLS policies (`002 §5`) apply to the underlying table
  and inherit through the view; the plugin gets isolation for
  free.
- The plugin's own migrations do not need to track core
  schema drift.

### 7.2 Raw table access

The analytics plugin **MAY** also read `eidan.llm_calls`
directly for queries the views do not cover (custom histograms,
ad-hoc cost-attribution joins against `messages.metadata`). The
plugin's manifest (`001_PLUGINS.md §1.1`) declares the access:

```yaml
# plugins/cost-analytics/plugin.yaml (excerpt — tier: pro)
db_access:
  read:
    - eidan.llm_calls
    - eidan.messages          # for metadata.failure join
    - eidan.conversations     # for grouping by conversation
    - eidan.v_llm_cost_per_user_day
    - eidan.v_llm_cost_per_conversation
    - ...
  write: []
```

The `db_access` block is a new manifest field that the loader
translates into `GRANT SELECT` statements at plugin install
(§7.4). Plugins that declare `write` on `eidan.*` tables are
**rejected** at install time — the ledger is core's, and PRO
analytics is by definition a read-only consumer.

### 7.3 Why both, not one or the other

The views are the contract; raw access is the escape hatch.
The asymmetry is deliberate:

- A dashboard that breaks because core renamed a `llm_calls`
  column is annoying. A dashboard that breaks because core
  renamed `v_llm_cost_per_user_day.day` is a release-noted
  breaking change with a deprecation window.
- A future graph that needs to join `llm_calls` to a
  not-yet-summarised column on `messages.metadata` would have
  to wait for a new view to ship. Raw access lets the plugin
  ship the graph today.

If a raw-access query becomes load-bearing for a dashboard
that ships, the plugin SHOULD upstream it as a new
`v_llm_*` view in core in the next minor release.

### 7.4 The plugin's Postgres role

The analytics plugin connects as a dedicated, read-only
Postgres role:

```sql
-- core migration (delivered alongside the views)
CREATE ROLE eidan_analytics_reader NOLOGIN;
GRANT USAGE ON SCHEMA eidan TO eidan_analytics_reader;
GRANT SELECT ON ALL TABLES    IN SCHEMA eidan TO eidan_analytics_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA eidan TO eidan_analytics_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA eidan
  GRANT SELECT ON TABLES TO eidan_analytics_reader;
```

A login role inherits from `eidan_analytics_reader` and is
configured by the operator; the plugin authenticates as that
login. PRO's RLS policies (`002 §5`) apply because the policies
do not exempt this role.

The plugin **MUST NOT** connect as the host's own role,
because the host has write privilege on `eidan.*` and granting
that to dashboard code is a meaningful expansion of blast
radius. The loader refuses to start the plugin without a
configured `analytics_reader` DSN.

---

## 8. Aggregation queries

This section gives the canonical SQL for each cap and each UI
counter. They are reproduced here so a reader can verify the
indexes from `003 §10` are sufficient and so the plugin's view
definitions are obvious.

### 8.1 Per-turn spend

```sql
SELECT COALESCE(SUM(cost_usd), 0) AS turn_cost_usd
FROM   eidan.llm_calls
WHERE  message_id = $1;             -- the anchor message id
```

Index: `idx_llm_calls_message` (`003 §10`). Hit rate: 100% of
turns; this is read on every pre-call check.

### 8.2 Per-conversation spend

```sql
SELECT COALESCE(SUM(cost_usd), 0) AS conversation_cost_usd
FROM   eidan.llm_calls
WHERE  conversation_id = $1;
```

Index: `idx_llm_calls_conversation` (`003 §10`).

### 8.3 Per-day rolling spend

```sql
SELECT COALESCE(SUM(cost_usd), 0) AS day_cost_usd
FROM   eidan.llm_calls
WHERE  user_id    = $1
  AND  started_at > now() - interval '24 hours';
```

Index: `idx_llm_calls_user_created (user_id, created_at DESC)`
(`003 §10`). Note `created_at` is used by the index; `started_at`
is consulted on the row but is within microseconds of
`created_at` for committed rows, so the index range scan is
selective enough. A future migration may add a `(user_id,
started_at)` index if this proves hot.

### 8.4 Per-user PRO window

Same shape as §8.3 with the window interval taken from
`user_budgets.window`.

### 8.5 Per-agent month spend

```sql
SELECT COALESCE(SUM(cost_usd), 0) AS agent_month_cost_usd
FROM   eidan.llm_calls
WHERE  agent_id   = $1
  AND  started_at > now() - interval '30 days';
```

Index: today the closest fit is `idx_llm_calls_provider_model_created`,
which does not key on `agent_id`. A core migration ships an
additional partial index when per-agent monthly enforcement is
turned on by any deployment; until then the query falls back
to `idx_llm_calls_user_created` with a planner-driven filter,
which is fine at MVP scale.

### 8.6 The single batched query

The §5.2 check reads four (PRO: five) aggregates. To save
round-trips, the runner issues one batched statement:

```sql
SELECT
  (SELECT COALESCE(SUM(cost_usd),0) FROM eidan.llm_calls
   WHERE message_id      = $1) AS turn_cost_usd,
  (SELECT COALESCE(SUM(cost_usd),0) FROM eidan.llm_calls
   WHERE conversation_id = $2) AS conversation_cost_usd,
  (SELECT COALESCE(SUM(cost_usd),0) FROM eidan.llm_calls
   WHERE user_id         = $3
     AND started_at > now() - interval '24 hours')
                              AS day_cost_usd,
  (SELECT COALESCE(SUM(cost_usd),0) FROM eidan.llm_calls
   WHERE agent_id        = $4
     AND started_at > now() - interval '30 days')
                              AS agent_month_cost_usd;
```

Each sub-query is independently index-supported; the planner
runs them in parallel. On a populated dev DB this query
completes in well under 5 ms.

---

## 9. Observability

Every turn writes a `metadata.budget` block on its anchor
message (`005 §5.1`):

```jsonc
{
  "budget": {
    "config": {
      "per_turn_usd": 0.50,
      "per_conversation_usd": 10.00,
      "per_day_usd": 5.00,
      "per_user_usd": null,
      "per_agent_month_usd": null
    },
    "checks": 14,                 // number of pre-call checks run
    "deny_count": 0,              // checks that returned deny
    "wrap_up_count": 0,           // checks that returned wrap_up
    "final_turn_cost_usd": 0.07,
    "final_session_cost_usd": 0.43,
    "exceeded": false
  }
}
```

Every `BudgetDecision.deny` writes a `llm_calls` row with
`role` = the role of the call that would have been made,
`error_type = "BudgetDenied"`, `cost_usd = 0`. These rows do
NOT count toward the cap on subsequent reads (the aggregate is
on `cost_usd`, which is `0`), but they ARE counted in the
analytics dashboards' "calls denied" metric (§7.1's
`v_llm_errors_per_day`).

Structured logs emit `budget.cost_usd`,
`budget.cap_state`, and `budget.reason` on every check, so
the operator can grep for "why did this turn get cut off"
without joining DB tables.

---

## 10. Migration packaging

The capture side requires no new migration — `llm_calls`
already carries `cost_usd` (`003 §9`). The enforcement and
analytics sides ship in a single **core** migration:

```
migrations/versions/<UTC-timestamp>_cost_budgeting.py
```

The migration:

1. Creates the `v_llm_*` views from §7.1.
2. Creates the `eidan_analytics_reader` role and grants
   `SELECT` on `eidan.*` (§7.4).
3. Adds a `metadata.budget` JSON path lint (no schema change;
   documented as a convention).
4. Adds a `(user_id, started_at)` partial index on
   `llm_calls` if benchmarks show §8.3 is a hot path; otherwise
   defers to a follow-up.

A PRO migration ships `user_budgets` (§4.6) plus its RLS
policies (`002 §5`). The analytics plugin's own migrations
add tables in `plugin_cost_analytics` for any aggregates the
plugin wants to cache locally; nothing about the analytics
plugin's local tables is core's concern.

`005 §10`'s reservation for "per-turn quotas and per-user cost
ceilings" is satisfied by this document and that bullet should
be removed from `005` in the next revision.

---

## 11. Reserved for later specs

Deliberately out of scope, to be specified in follow-ups:

- **Wire DTOs.** `agentic/TurnCost.schema.json` and the
  budget-deny envelope shape — owned by `004_SCHEMAS.md` once
  the in-process shape has stabilised.
- **Hard-stop semantics with strict serialisability.** §5.5's
  default accepts a small overshoot at the boundary; an
  opt-in mode that locks the aggregate would prevent it. The
  hook (the PRO plugin's toggle) is here; the policy and the
  lock-row design are not.
- **Materialised views for the dashboards.** §7.1 starts with
  plain views; a future spec may move the hot ones to
  materialised views with a refresh strategy.
- **Per-tool quotas.** Today every cost rides on an LLM call.
  A tool with its own upstream cost (a paid API call) wraps
  itself in a spawn and inherits the cap, but a deployment
  that wants a "search tool can spend $N/day" cap distinct
  from the LLM cap needs its own ledger.
- **Budget forecasts and alerts.** The analytics plugin
  consumes the ledger; turning the ledger into a forecast
  ("at this rate you will exhaust on day 19") is its own
  document.
- **Currency conversion.** `cost_usd` is the only currency
  column. Operators billed in another currency convert at
  display time; multi-currency analytics is the analytics
  plugin's problem.
- **Refund / adjustment entries.** Today the ledger is
  append-only and immutable (`003 §1.3`). A provider-side
  credit (the upstream refunds tokens) is not represented;
  if needed, a follow-up will add `eidan.llm_call_adjustments`
  rather than mutate the immutable ledger.
- **Cross-worker spend reconciliation.** The cap check reads
  `llm_calls` which is single-source-of-truth across workers,
  but a deployment that shards the ledger across databases
  would need a reconciliation strategy. Out of scope until
  sharding is.

---

## 12. Design delta — recomputable cost (proposed)

Status: **Proposed.** Revisits §2.1, §3.3, §3.4. Tracked in
`sielay/eidan#204`. Not implemented until the shape is agreed; until
then the frozen behaviour of §2.1 is the only behaviour.

### 12.1 Why revisit "frozen cost"

`§2.1` freezes `cost_usd` on the row and the analytics path "never
multiplies tokens by a current price — it sums `cost_usd`." The
strength is immutable audit. The weakness: a **stale or wrong price
is enshrined forever**, and a price correction can never be
back-applied. Anthropic and OpenAI expose no pricing API and put no
cost in the response or headers — only token usage — so the price
table is maintained out-of-band and *will* sometimes lag a price
change or carry a bad value (the acute form is the unpriced-model
silent-$0 fixed under #203). Freezing a guess as if it were ground
truth is the failure this section addresses.

The reframe: **tokens are ground truth** (already on the row, `§2.1`);
**price is a derived multiplier** that decays.

### 12.2 Principle — freeze for money, recompute for insight

- Keep `cost_usd` on the row, frozen — but reframed as *"cost as
  priced at write time,"* an audit/enforcement snapshot, not the sole
  truth.
- Add **recomputation**: `cost = tokens × price` where the price is
  the one effective at the call's `started_at`, against an
  effective-dated table.
- **Enforcement (`§5`) and invoices read the frozen value** —
  deterministic, cheap, and race-stable, so `§5.5`'s slip-tolerance
  reasoning is untouched. **Analytics (`§7`) and forecasting may read
  the recomputed value** so corrections propagate.

### 12.3 The effective-dated (bitemporal) price table

```sql
CREATE TABLE eidan.model_prices (
  model           text        NOT NULL,
  effective_from  timestamptz NOT NULL,   -- applies to usage from here
  recorded_at     timestamptz NOT NULL    -- when the system learned it
                              DEFAULT now(),
  input           numeric(12, 6) NOT NULL,
  output          numeric(12, 6) NOT NULL,
  cache_read      numeric(12, 6) NOT NULL,
  cache_creation  numeric(12, 6) NOT NULL,
  source          text,                   -- provenance: "default" |
                                          -- "anthropic.page" | "azure.api" | …
  source_ref      text,                   -- URL / API id / parser version
  fetched_at      timestamptz,
  PRIMARY KEY (model, effective_from, recorded_at)
);
```

Two time axes (bitemporal):

- `effective_from` — when a price applies to **usage**.
- `recorded_at` — when this system **learned** it.

A call's cost uses the `model_prices` row with the greatest
`effective_from ≤ call.started_at` for that model. The `recorded_at`
axis answers the as-of-knowledge question — *"what did we **think**
this cost last week, before a correction landed"* — by filtering
`recorded_at ≤ knowledge_time`. Provenance columns make every
recompute auditable and a bad ingest traceable.

### 12.4 Ownership — core schema + seed, bundle maintenance

- **Core** owns the table schema, the recompute view, and **ships it
  seeded from the provider default tables** (`providers/*.py`
  `_DEFAULT_PRICING`), so a core-only deployment still prices exactly
  as today.
- A **paid bundle** owns the *ingestion* that keeps the table fresh
  (scrape-and-alert for Anthropic/OpenAI, API for Azure/OpenRouter).
  Core reads whatever rows exist; absent fresh rows it falls back to
  the seed. Same opportunistic `LEFT JOIN`-on-`to_regclass` pattern
  `§4.6` already uses for `user_budgets`.
- The `EIDAN_PRICE_<MODEL>_*` env overrides (`§3.4`) remain the
  highest-priority overlay; optionally they may carry an
  `effective_from` so a negotiated-rate change is itself dated.

### 12.5 Recompute surface

A read-only view (`§7.1` naming):

| View                       | Purpose                                                                                  |
|----------------------------|------------------------------------------------------------------------------------------|
| `eidan.v_llm_cost_recomputed` | `llm_calls` joined to `model_prices` on (`model`, price effective at `started_at`), exposing `recomputed_cost_usd` alongside the frozen `cost_usd`. Analytics MAY prefer it; enforcement never does. |

`cost_usd`'s meaning for `§5` is unchanged; no migration to the
enforcement path.

### 12.6 What does NOT change

- `§5` enforcement still reads the frozen `cost_usd` (race-stability,
  `§5.5`).
- The ledger stays **append-only** (`§2.2`); recompute is a read-side
  projection, never a mutation. This also subsumes part of `§11`'s
  "refund / adjustment" item: a corrected price is a **new
  effective-dated `model_prices` row**, not a ledger edit.

---

## 13. Design delta — finer budget scopes & throttle (proposed)

Status: **Proposed.** Extends `§4`–`§5`. Tracked in
`sielay/eidan#205`. Not implemented until agreed.

### 13.1 Two new scopes — per-node, per-model

- **Per-model.** `llm_calls` already carries `model` (`§7.1`
  `v_llm_cost_per_model_day`, `§8.5` index). A per-model cap is a new
  aggregate keyed on `model` — cheap, no schema change. Config:
  `per_model_day_usd` as a `{model: usd}` map.
- **Per-node.** `llm_calls` carries no node identity today. Add node
  attribution **reusing the node identity from
  `024_NODE_TELEMETRY.md`** (do not invent a new one), populated from
  the host's configured node at write time. Config:
  `per_node_day_usd`. Index: a partial `(node_id, started_at)` index
  when any deployment enables it (the lazy-index posture of `§8.5`).

Both fold into the same `min()` composition as `§4.7` and are **hard
caps** by default. Aggregates mirror `§8`:
`SUM(cost_usd) WHERE model = $1 AND started_at > now() - $window`,
and the same keyed on `node_id`.

### 13.2 A throttle tier — the `downgrade` decision

Today the ladder is `allow → wrap_up` (soft, per-turn `§4.1`) `→ deny`
(hard) — a cliff. Insert **`downgrade`** between `allow` and the caps:
fired when a scope enters its **warn band** (≥ `warn_fraction` of cap,
the `0.8` default of `§6.3`) but is not yet over.

Effect: **bias model selection cheaper** — drop the expensive tiers
and refuse escalation — *before* refusing work. `BudgetDecision`
(`§5.4`) gains a fourth variant:

```python
BudgetDecision.downgrade(reason: str, max_tier: str)
# max_tier = the most expensive model tier still permitted this turn
```

### 13.3 How it reaches the sizer

The pre-call check (`§5.2`) runs at spawn, but the model is chosen
earlier, at the sizer (`005 §3` step ④). So budget pressure must reach
the sizer. Two coordinated hooks:

1. **Sizer-time ceiling.** `resolve_budget_config` (`§4.7`) already
   runs per turn; expose the warn-band pressure so the sizer caps its
   `_ALLOWED_MODELS` ladder (drop sonnet/opus when pressured) and
   refuses the "use opus" escalation
   (`classifiers/sizer.py:_ESCALATION_MODEL`).
2. **Pre-call enforcement.** If a call still arrives above `max_tier`
   (sizer disabled via `EIDAN_SIZER_ENABLED`, a plugin-chosen model,
   an escalation), the pre-call check returns `downgrade` and the
   runner **substitutes the permitted cheaper model** rather than
   denying — only crossing to `deny` at the hard cap.

The **mechanism** is core; the **tier ladder** (which model is "one
cheaper") is configurable, defaulting to the provider's known tier
order so a core-only deploy degrades too. A bundle may override the
ladder.

### 13.4 The updated ladder

```
allow
  → downgrade   (warn band: cheaper model, no escalation)
  → wrap_up     (per-turn soft cap §4.1: finish, tools off)
  → deny        (hard caps)
```

Each step is strictly more restrictive than the last.

### 13.5 Race & autonomy notes

- `downgrade` is advisory/graceful, so `§5.5`'s slip-tolerance
  reasoning is unchanged — a race just means one call at a slightly
  higher tier.
- **Per-autonomous-run ceilings** ("this self-closing loop may spend
  $X then halt") are a *consumer* of this seam, not part of it:
  autonomous-loop governance (`027` `LoopBudget`) composes a per-run
  cap and uses `downgrade` for graceful throttle before its hard stop.
  Core provides the scope + the decision; the per-run policy lives
  with the loop governor (tracked downstream).

### 13.6 Config additions (`BudgetConfig`, `§4.6`)

```python
per_node_day_usd:   float | None          # hard; §13.1
per_model_day_usd:  dict[str, float]       # hard; §13.1 (per model id)
downgrade_ladder:   list[str] | None       # optional tier override; §13.3
# warn_fraction already exists (§6.3) and drives the downgrade band.
```
