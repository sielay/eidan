# sentry — core plugin

The continuous-thinking loop (`docs/SENTRY_FEATURE_SPEC.md`). On a
schedule (default every 5 minutes) it inspects the operator's recent
`eidan.*` state, runs pattern detectors, and proactively surfaces
things the agent should react to — overdue commitments, long silences,
accumulating shelves of unactioned work.

## What it ships

A single scheduled behaviour:

| Behaviour      | Trigger        | Handler                  | Kind       |
|----------------|----------------|--------------------------|------------|
| `sentry:tick`  | `schedule:PT5M` | `eidan_sentry.plugin:Plugin` | `llm_turn` |

The tick reads core `eidan.*` tables for state and writes to the
plugin-private `plugin_sentry.*` tables for tick logs and nudge dedupe.
Detected patterns land as `eidan.escalations` rows the UI inbox
surfaces; high-severity ones can also escalate via `ctx.spawn_turn`
into an agent-initiated turn (when a provider is wired — `None` on
unit-test boots).

## Detectors (Phase 1)

Phase 1 ships **deterministic** detectors only
(`eidan_sentry.patterns`):

| Detector         | Fires when                                                              |
|------------------|-------------------------------------------------------------------------|
| `overdue_events` | an `eidan.events` row is past `due_at` with `status='pending'` (one pattern per event). |
| `idle_too_long`  | no user message in the last `EIDAN_SENTRY_IDLE_THRESHOLD_HOURS` (default 48). |
| `scope_drift`    | more than `EIDAN_SENTRY_SCOPE_DRIFT_CEILING` (default 7) pending events in the next 30 days. |

## Configuration

| Env var                       | Default                          | Effect                                                       |
|-------------------------------|----------------------------------|--------------------------------------------------------------|
| `EIDAN_SENTRY_ENABLED`        | node-aware (OFF on Fly, ON elsewhere) | `"1"` enables the tick, `"0"` disables it. Fly defaults OFF so the LLM-calling tick is opt-in there; Pi/k8s/Heroku/local default ON. |
| `EIDAN_SENTRY_TICK_INTERVAL`  | `PT5M`                           | ISO-8601 duration between ticks. Read verbatim at activation — no in-flight rescheduling. |
| `EIDAN_SENTRY_MODEL`          | `phi3`                           | Model the open-ended matcher asks the host's provider for. Pinned per-node so a cheap local model can drive sentry independently of the foreground agent. |

## What's deferred

The Phi-3 / Ollama-driven open-ended pattern matcher from the spec's
*Core Loop* section lands once core has a **local-model provider
adapter**. Until then `EIDAN_SENTRY_MODEL` is read but the deterministic
detectors do all the work.

The plugin is loaded automatically by the host's plugin loader at
startup. Enablement is gated on `EIDAN_SENTRY_ENABLED` per the table
above; once `make migrate` has run and the node boots, the tick begins
firing on schedule.
