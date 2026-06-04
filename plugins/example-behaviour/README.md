# example-behaviour — core plugin

A Phase 1.5 **test fixture**, not a product surface. It exists so the
host's behaviour-dispatch path (`docs/006`) has something concrete to
fire against until real bundles land.

## What it ships

A single cron-triggered behaviour:

| Behaviour              | Trigger          | Handler                          | Kind         |
|------------------------|------------------|----------------------------------|--------------|
| `example-behaviour:tick` | `cron:* * * * *` | `example_behaviour.behaviours:tick` | `tool_chain` |

`on_activate` calls `ctx.register_behaviours(...)`; the dispatcher's
`start()` then schedules `tick` against APScheduler.

## How the handler behaves

`tick` does pure in-memory bookkeeping — no LLM, no tools. It records
each firing in a module-level `_State` and short-circuits on a repeat
`TriggerEvent.idempotency_key`. That dedupe is redundant with the
registry-level dedupe in `BehaviourRegistry`, but doubling it up here
mirrors what real handlers should do: the host guarantees
**at-least-once** delivery, so idempotency is the handler author's
responsibility (`docs/001 §5.2`).

`make_behaviours()` is kept as a module-level helper so the dispatch
smoke tests can exercise the behaviour subsystem in isolation, without
booting the loader. Keep it in lock-step with `plugin.yaml`'s
`behaviours[]` — the manifest loader refuses to activate a plugin whose
runtime dataclass set diverges from the declared one (`docs/006 §2.3`
`BehaviourManifestMismatch`).

## Out of scope

No persistence, no real product behaviour. Production handlers would
write to the plugin's own `plugin_<name>` schema; this one keeps state
in a process-local list a test reads via `state` / resets via `reset()`.

The plugin is loaded automatically by the host's plugin loader at
startup; no manual registration step.
