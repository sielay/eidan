# 022 — Escalation envelope

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Agentic loop, Bicameral critique),
`docs/005_AGENTIC_LOOP.md` (§5.5 primary loop, §6 error handling),
`docs/006_BEHAVIOURS_TRIGGERS.md` (§5 classifier, §8 handler contract),
`docs/009_FAILURE_DETECTION.md` (within-turn signal set, classifier
fallback), `docs/014_UI_SURFACE.md` (operator-facing surfaces),
`docs/SENTRY_FEATURE_SPEC.md` (the §3 envelope is what Sentry emits
when it detects high-severity patterns)

This document specifies the **mechanism by which an agent, behaviour,
or subagent signals "I am blocked, I cannot make further progress
without help" and how that signal is routed to the right audience**.
It is distinct from — and lives alongside — failure detection
(`009`):

- `009` decides *"the primary's output is suspect, fire the critic"*
  from within-turn signals. The audience is the loop itself.
- `022` decides *"the agent has identified a blocker it cannot resolve;
  surface it"* from agent-emitted signals. The audience is upstream —
  another agent, a queued review, or the human operator.

The pattern is borrowed from Gas Town's severity-routed escalation
(`gt escalate` → tracked beads → Deacon / Mayor / Overseer). Eidan
has no swarm of agents to route between, so the routing tiers are
different — but the primitive is the same: a structured way for an
agent to say "I'm stuck" rather than silently failing the turn.

Phase 1 (this commit): the envelope is pinned in `§3`. The
implementation lives at `eidan_backend/escalations.py` —
`Escalation` dataclass, `EscalationSeverity` + `EscalationReason`
enums, `record_escalation` / `list_escalations` /
`acknowledge_escalation` / `resolve_escalation` helpers. The
`eidan.escalations` table holds rows. HTTP endpoints
`GET /api/escalations` + `POST /api/escalations/{id}/acknowledge` +
`POST /api/escalations/{id}/resolve` surface the lifecycle to the
operator UI. The web app's `/escalations` route renders the inbox.

Out of scope (deferred):

- Cross-instance escalation routing (escalation raised on Pi,
  surfaced on Fly.io). Today the escalation lives in shared
  Postgres so every instance reads the same inbox; routing it to a
  specific operator in a multi-user install is a follow-up.
- Escalation analytics (mean-time-to-resolution, escalation rate
  per behaviour). Reporting is a separate concern.
- Auto-resolution. An escalation surfaces; the operator (or a
  future agent) resolves it. No retry loops in the envelope.
- Severity inference. The agent emitting the escalation chooses
  the severity. We do not classify severity post-hoc.

---

## 1. Vocabulary

| Term                  | Definition                                                                                                                                                          |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Escalation**        | A structured "I am blocked" row emitted by an agent or behaviour. Persisted in `eidan.escalations`. Carries severity, reason class, evidence, and a suggested next action. |
| **Severity**          | `low` / `medium` / `high`. Drives the routing (`§4`): `low` lands in the inbox only; `medium` lands in the inbox AND attempts a notify push; `high` same as medium plus interrupts the next turn (Phase 2 follow-up). |
| **Reason class**      | A pinned enum: `missing_input`, `permission_denied`, `external_failure`, `ambiguous_intent`, `over_budget`, `over_capacity`, `unrecoverable_error`, `other`.        |
| **Evidence**          | A list of opaque references (message id, llm_call id, external trace id) the operator or downstream agent can pull on to understand the blocker without re-asking.   |
| **Suggested action**  | A free-text hint from the agent: *"need credentials for X"*, *"need clarification on Y"*, *"retry in 30m"*. Not a command — a recommendation.                       |
| **Lifecycle**         | Status flow: `pending` → `acknowledged` → `resolved`. The operator advances each step via the HTTP endpoints; `resolved_at` lands automatically on resolution.       |

## 2. Decision tree — when to escalate vs critic

| Scenario | Reach for |
|---|---|
| Primary's output looks wrong (refused, truncated, repeated, …) — observation from outside the agent. | Failure detector + critic (`docs/009`). |
| Agent self-reports "I tried this and it doesn't work / I need credentials I don't have / this is ambiguous". | Escalation. |
| Detector classifier (cross-turn) says the conversation has drifted. | Failure detector fallback (`docs/009 §6`). |
| Behaviour fired (cron / schedule / webhook) and the handler hit an unrecoverable error. | Escalation (severity = medium, reason = `unrecoverable_error`). |
| Sentry pattern fires medium+ severity. | Escalation (the Sentry plugin emits via `ctx.notify` first, falls back to escalation when the notify channel fails — see `docs/SENTRY` plus `notifications.py`). |

## 3. The wire envelope

```
{
  "severity":         "low" | "medium" | "high",
  "reason_class":     "missing_input" | "permission_denied"
                      | "external_failure" | "ambiguous_intent"
                      | "over_budget" | "over_capacity"
                      | "unrecoverable_error" | "other",
  "evidence":         [<string>, ...],
  "suggested_action": <string | null>,
  "conversation_id":  <uuid | null>,
  "agent_id":         <uuid | null>,
  "metadata":         <object>
}
```

Persisted as one row in `eidan.escalations`. `status` defaults to
`pending`; `created_at` and `updated_at` are stamped by the host.
`resolved_at` is `null` until the operator resolves it.

A future PR will land the JSON Schema for this envelope in
`packages/schemas/schemas/core/agentic/Escalation.schema.json` so
external clients (MCP consumers, Sentry plugin handlers) can validate
against the same shape the host enforces.

## 4. Routing by severity

| Severity | Action |
|---|---|
| `low`    | Inbox row only. The operator sees it next time they open `/escalations` or query `GET /api/escalations`. Used for soft signals — "noticed something, not urgent." |
| `medium` | Inbox row + best-effort out-of-band push via `ctx.notify(channel, text)` (typically Telegram). The push is one-per-day-per-pattern; the inbox row is the durable record. |
| `high`   | Same as `medium` in Phase 1. Phase 2 follow-up: high-severity escalations also interrupt the next user turn (the primary's pre-flight reads pending high escalations, the loop renders them into the system prompt so the model can address them). Reserved spec. |

## 5. Reserved for follow-ups

- The JSON Schema for the envelope in `packages/schemas/`.
- Phase 2 routing for `high` severity (interrupt the next turn).
- Cross-instance escalation routing (which instance pushes the
  notify when multiple instances share Postgres).
- Per-channel `ctx.notify` retry policy (today the call is
  best-effort; a queued retry with exponential backoff lands once
  failure rates merit it).
- Escalation analytics — mean-time-to-resolution, rate per
  behaviour, severity heatmaps. The data is in `eidan.escalations`;
  the reporting layer is its own spec.
- Severity classifier — a small LLM call that takes an agent's
  raw "I'm stuck" message and picks the right `(severity,
  reason_class)`. Optional; agents that prefer to self-classify
  bypass it.
