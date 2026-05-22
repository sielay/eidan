# Glossary

The 30-ish cross-spec terms a reader meets while learning eidan,
indexed to the spec section that pins each one. Use this page as
the gloss when a numbered spec mentions a term and you want the
short answer without bouncing through three docs.

Terms are grouped by area; within each group they're alphabetical.

---

## Identity and authority

| Term | What it means | Where defined |
|---|---|---|
| **Identity** | The post-validation record carried through every turn — `user_id`, optional `email`, `session_id`, `aal`, `raw_claims`. Built from the JWT by the auth middleware, or from `Identity.synthetic_for_agent` for agent-initiated turns. | `docs/011 §4.3` |
| **Single-operator pin** | `EIDAN_AUTH_ALLOWED_EMAIL` — the only email the native magic-link endpoint will mint a link for. Unset means refuse-all. | `docs/011 §3.1` |
| **Synthetic identity** | An `Identity` built for an agent-initiated turn (cron / Sentry / scheduled behaviour). Carries `aal='agent'` and `raw_claims.synthetic=True` so tools can refuse paths reserved to real users. | `docs/005 §10`, `identity.py:Identity.synthetic_for_agent` |

## Memory model (`eidan.*`)

| Term | What it means | Where defined |
|---|---|---|
| **agent_context** | Per-(user, agent_slug) row carrying code defaults + user overrides. Drives the persona override chain. | `docs/003 §7` |
| **conversations** | Thread container; every `messages` row references one. | `docs/003 §2` |
| **events** | Calendar-like rows: type, title, `due_at`/`occurred_at`, status, recurrence. Substrate for reminders, routines, deadlines. | `docs/003 §4` |
| **knowledge** | Curated, skill-tagged markdown the agent has been asked to remember. Has a slug; supports wikilinks → `knowledge_links`. | `docs/003 §6`, `docs/017` |
| **knowledge_links** | Adjacency rows recording `[[wikilink]]` references between `knowledge` bodies. Powers backlink + neighbour queries. | `docs/017 §4` |
| **llm_calls** | Per-provider-call telemetry (tokens, cost, latency). Immutable. Drives cost rollups and the failure detector. | `docs/003 §9`, `docs/010` |
| **messages** | Append-only turn log, tree-shaped via `parent_message_id`. Roles: `user` / `assistant` / `tool`. | `docs/003 §3` |
| **notes** | Working memory the agent writes during a conversation. Scoped to a `conversation_id`. | `docs/003 §5` |
| **plugin_state** | Plugin lifecycle bookkeeping — first-install marker. Not memory. | `docs/001 §8` |
| **user_context** | Durable user facts the agent reads on every turn: identity, goals, constraints, preferences, projects. | `docs/003 §8` |

## Plugins

| Term | What it means | Where defined |
|---|---|---|
| **Bundle** | A standalone private sibling repo carrying one paid tier's plugins. Installed into the operator's local `plugins/` via `eidan plugins install`. | `docs/018 §2` |
| **Plugin** | A self-contained unit declared by one `plugin.yaml` under `plugins/<name>/`. Can contribute backend code, frontend, migrations, behaviours, an MCP server. | `docs/001` |
| **PluginContext** | The host surface a plugin receives at activation: `db`, `secret`, `notify`, `register_router`, `register_behaviours`, `register_tools`, `identity`. | `docs/001 §2.2`, `plugins/context.py` |
| **Tier** | Manifest metadata: `core` / `pro` / `commercial`. Used for grouping in the CLI; not a directory hierarchy. | `docs/001 §1.1` |

## Loop and triggers

| Term | What it means | Where defined |
|---|---|---|
| **Behaviour** | A registered Python handler plus declarative metadata (trigger, mode, prompt stanza, tools). | `docs/006 §2.1` |
| **Behaviour classifier** | The cheap LLM call that picks which `intent:` triggers fire for a given user message. New role on `llm_calls.role`. | `docs/006 §5` |
| **Cron trigger** | A behaviour activated by a standard 5-field cron expression. Fires on the host's clock; gated by an advisory lock for multi-instance dedupe. | `docs/006 §3`, `docs/021` |
| **Failure classifier** | The LLM-driven step that confirms or vetoes a deterministic-detector verdict (`docs/009 §6`). One row on `llm_calls.role = 'failure_classifier'` per firing. | `docs/009 §6` |
| **Intent trigger** | A natural-language description matched by the behaviour classifier. | `docs/006 §3` |
| **Loop iteration** | One pass through the primary call inside a turn. Iteration ≥ 2 happens when the model emits `tool_use`. Capped at `_MAX_TOOL_ITERATIONS = 12`. | `docs/005 §5.5` |
| **Primary call** | The provider call that produces the assistant's actual response. Picked by the sizer; preceded by scope + intent. | `docs/005 §5.5` |
| **Scope classifier** | The cheapest classifier — tags the user message with 1–5 skill labels. Drives behaviour filtering. | `docs/005 §5.2` |
| **Sizer** | Picks the model class (small / medium / large) for the primary call based on scope + a short prompt. | `docs/005 §5.3` |
| **Turn** | One inbound user message → one final assistant reply. May involve N primary iterations + classifier calls. Eagerly persisted at every step. | `docs/005 §1.1` |
| **TurnContext** | What the loop carries through a turn: `identity`, `conversation_id`, optional `system_prompt`, `depth`, `parent_message_id`. | `loop.py:TurnContext` |

## Subagents

| Term | What it means | Where defined |
|---|---|---|
| **Spawn** | The primitive that opens a nested turn from inside a parent. `spawn_turn` recursively calls `run_turn`. Capped at depth 3. | `docs/008 §3`, `spawn.py` |
| **SpawnRequest** | The frozen dataclass parents construct to describe a child turn. | `docs/008 §3.1` |

## Behaviour modes

| Term | What it means | Where defined |
|---|---|---|
| **AUTO** | Loaded as a system-prompt stanza + tool surface; the model decides if and how to invoke. | `docs/006 §7.1` |
| **OFFER** | Surfaced to the user as a chip; the handler runs only after explicit confirm. | `docs/006 §7.2` |

## Failure detection

| Term | What it means | Where defined |
|---|---|---|
| **Cross-turn signal** | Pattern observed in the conversation tail (repeated correction, re-asked question, frustration markers). Fires before the primary. | `docs/009 §3.2` |
| **Critic** | The LLM-driven second-opinion step that runs when the failure detector flags a turn. Bicameral with the primary. | `docs/005 §5.7`, `docs/009 §5` |
| **Within-turn signal** | Pattern observed in the just-completed primary output (empty response, refusal, loop exhausted, echoed question). | `docs/009 §3.1` |

## External surfaces

| Term | What it means | Where defined |
|---|---|---|
| **Escalation** | A structured "I'm blocked" envelope an agent / behaviour emits. Persisted in `eidan.escalations`; surfaced in the operator's inbox. | `docs/022 §3` |
| **MCP server (inbound)** | The host exposes a subset of registered tools to external MCP clients (Claude Desktop, IDE plugins). Tag tools with `expose_to_external_mcp=True`. | `docs/013 §4.1` |
| **MCP server (outbound)** | A plugin wraps an upstream MCP server; the host registers each upstream tool into its `ToolRegistry` so the agent sees them alongside local tools. | `docs/013 §4.2` |
| **Notification channel** | A registered out-of-band surface plugins use to nudge the operator. Plugins call `await ctx.notify("telegram", text)`; the bootstrap registers each adapter. | `notifications.py` |
| **Seance** | The CLI command that loads a prior conversation's transcript and asks the model a question about it. `eidan seance --conv <id> -p "<q>"`. | `docs/023`, `apps/cli/eidan_cli/seance.py` |
| **Sentry** | The continuous-thinking-loop plugin. Ticks every 5 minutes, runs pattern detectors against the operator's state, emits escalations / nudges / spawns turns. | `docs/SENTRY_FEATURE_SPEC.md`, `plugins/sentry/` |
| **Webhook trigger** | A behaviour declared with `webhook:<slug>` is reachable at `POST /api/webhooks/<plugin>/<slug>`. Auth-bypassed; rate-limited per `(plugin, slug, ip)`. | `docs/006 §3`, `http/rate_limit.py` |

## Build + release

| Term | What it means | Where defined |
|---|---|---|
| **Flat-commit release** | The public mirror is a single squashed commit per release tag, not a replay of this repo's history. | `docs/016 §5` |
| **Forbidden-string catalogue** | The list `release/forbidden-strings.txt` of terms that must not appear in the public tree. Enforced by a CI gate. | `docs/016 §4` |
| **License-header check** | CI gate that fails any new `.py` / `.ts` file added without an `SPDX-License-Identifier: AGPL-3.0-or-later` line. Additions only. | `.github/workflows/license-header.yml` |
| **Sanitisation tree** | Throwaway working tree the release script produces by stripping operator-internal artefacts from this repo. | `docs/016 §1` |

## Cost + budgeting

| Term | What it means | Where defined |
|---|---|---|
| **Per-day cap** | `EIDAN_MAX_DAILY_COST_USD` opt-in ceiling on the user's rolling 24h spend. Pre-flight gate; new turns get a 402 when exceeded. | `docs/010 §2`, `loop.py`, `http/routes.py` |
| **Per-turn cap** | `EIDAN_MAX_TURN_COST_USD` (default $1.00) hard stop *during* a turn. The loop short-circuits before the next provider call when the running cost crosses. | `docs/010 §2`, `loop.py` |

---

## Reading order

A first-time reader can follow the numbered specs in this order to
build the architectural picture without bouncing:

1. `docs/ARCHITECTURE.md` — the big picture
2. `docs/001_PLUGINS.md` — the plugin contract (everything is a plugin)
3. `docs/003_MEMORY_DDL.md` — the tables the agent reads + writes
4. `docs/005_AGENTIC_LOOP.md` — how a turn runs end to end
5. `docs/011_AUTH_FLOW.md` — how identity flows in
6. `docs/006_BEHAVIOURS_TRIGGERS.md` — how plugins extend the loop
7. `docs/004_SCHEMAS.md` — the JSON-Schema-to-Pydantic-and-Zod pipeline
8. `docs/018_DISTRIBUTION_AND_BUNDLES.md` — how paid bundles fit
9. `docs/SENTRY_FEATURE_SPEC.md` — the always-on plugin shape

Everything else (007 providers, 008 subagents, 009 failure, 010 cost,
012 secrets, 013 MCP, 014 UI, 016 sanitisation, 017 knowledge links,
019 commands, 020 licensing, 021 cross-instance, 022 escalation,
023 seance, 025 agent DB introspection) reads cleanly once the
foundation above is in place.
