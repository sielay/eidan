# Sentry: Continuous Thinking Loop — Feature Spec

**Status:** Design proposal for Eidan Core  
**Scope:** Optional feature, plugin-enabled, multi-node capable  
**Target:** Pi 5 (4GB) + Phi-3 mini (local inference)

---

## Vision

A **sentry** is a lightweight, always-on agentic loop running on a local node (Pi, mini PC, or cloud instance) that continuously observes the owner's state, goals, and memory—and proactively steers without waiting for a user prompt.

Unlike cron-based reminders (passive, time-triggered), the sentry is **active and contextual**:
- Notices patterns (stress cycle, skipped commitments, spinning thoughts)
- Queries relevant memory just-in-time (wellness data, emails, ideas, past conversations)
- Escalates to Claude for complex reasoning when needed
- Suggests actions, flags conflicts, and surfaces opportunities
- Acts as a "hive brain" across multiple nodes

**Examples:**
- "Lukasz hasn't logged food in two days—what's up? Checking wellness plugin… energy is low. Maybe suggest a check-in?"
- "Lukasz mentioned needing ADHD meds weeks ago. Let me search emails and recent convos—any progress? If not, nudge."
- "Lukasz likes LEGO and LOTR. Checking MCP tools for new releases or deals on eBay/LEGO store—found something interesting."
- "Lukasz captured several ideas on the shelf recently. Let me brainstorm which ones are adjacent and worth exploring together."
- "Who am I? What's my role? How can I get better? Reviewing agent_context, recent behaviours, and user feedback to reflect."

---

## Architecture

### Core Loop (Phi-3 local inference)

Runs every **5–15 minutes** (configurable) on the sentry node:

```
1. QUERY STATE (lightweight)
   ├─ user_context (identity, goals, constraints, preferences)
   ├─ events (active episodes, due dates, overdue items)
   ├─ notes (last 3 agent notes from this conversation)
   ├─ user mood/energy (from wellness plugin, if available)
   └─ stress signals (from memory, if available)

2. PATTERN MATCH (Phi-3 inference, ~1–2s)
   ├─ Is user in stress cycle step 1–2?
   ├─ Skipped gym / missed commitment?
   ├─ Late-night spinning / context debt?
   ├─ Overcommitted / scope drift?
   ├─ Wellness gap (food, sleep, meds)?
   ├─ Idea accumulation (capture shelf growing)?
   └─ Relationship/partnership check-in needed?

3. PLUGIN QUERIES (if enabled)
   ├─ nutrition plugin: "Any gaps in logging? Energy/mood correlation?"
   ├─ calendar plugin: "Overbooked? Conflicts?"
   ├─ ideas plugin: "Brainstorm adjacent ideas?"
   ├─ email plugin: "Follow-up on past mentions (ADHD meds, etc.)?"
   ├─ shopping plugin: "Interests (LEGO, LOTR, books) — any deals?"
   └─ [other plugins via MCP]

4. DECIDE (Phi-3 or escalate)
   ├─ If pattern is simple → generate micro-nudge locally
   ├─ If pattern is complex → escalate to Claude (queue async call)
   └─ If no pattern → log observation, move to next tick

5. ACT (if needed)
   ├─ Send Telegram nudge (batched, not every tick)
   ├─ Create event / flag episode
   ├─ Insert note into working memory
   └─ Queue escalation job for Claude
```

### State Representation (human brain analogy)

The sentry doesn't replay full conversation history. Instead, it keeps **limited working context**:

```json
{
  "tick_id": "sentry-2026-05-19-15:46",
  "user_mood": 2,                    // 1–5 scale (from wellness plugin)
  "user_energy": 2,                  // 1–5 scale
  "stress_signals": [                // recent stress indicators
    "too_many_ideas",
    "late_night_spinning"
  ],
  "active_goals": [                  // top 3 user goals from user_context
    "exit_employment_on_terms",
    "build_ventures_to_8k_mo",
    "improve_family_time"
  ],
  "active_episodes": [               // due/overdue episodes
    { "type": "event", "title": "First Aid Course", "due_at": "2026-06-14" },
    { "type": "commitment", "title": "Cubs pickup Thu 18:00", "status": "active" }
  ],
  "recent_notes": [                  // last 3 agent observations
    { "created_at": "2026-05-18T22:15", "body": "User spinning on marketing strategy..." },
    { "created_at": "2026-05-18T20:30", "body": "Skipped gym today, energy low" },
    { "created_at": "2026-05-18T14:00", "body": "Captured 2 new ideas on shelf" }
  ],
  "last_wellness_check": "2026-05-19T06:00",  // when wellness data was last queried
  "escalations_pending": 1            // number of async Claude jobs queued
}
```

### Escalation to Claude

When the sentry detects a **complex pattern** (e.g., "stress cycle + overcommitment + family time debt"), it:

1. Queues an async job with the full context needed (not the entire conversation, just the relevant slice).
2. Claude runs a deeper analysis and returns a structured response (e.g., "suggest a break", "flag scope creep", "nudge on ADHD meds").
3. The sentry integrates the response into a Telegram nudge or creates an episode.

**Cost:** ~2–3 Claude calls per week (vs. every 5 min if Claude ran locally).

---

## Behaviours (Plugin-defined)

Behaviours are registered via the plugin contract and triggered by the sentry loop. Examples:

### Wellness Behaviours

```python
# Triggered if wellness plugin is enabled and energy < 2
async def wellness_check(ctx, trigger):
    """Suggest rest or movement based on energy/mood."""
    mood = await ctx.db.query("SELECT mood FROM wellness WHERE user_id = ?")
    if mood < 2:
        return BehaviourResult(
            action="nudge",
            message="Energy is low. Rest, movement, or talk?",
            escalate_to_claude=False
        )

# Triggered if food logging gap > 2 days
async def nutrition_gap_check(ctx, trigger):
    """Alert if user hasn't logged food."""
    gap = await ctx.db.query("SELECT days_since_last_log FROM nutrition_logs")
    if gap > 2:
        return BehaviourResult(
            action="escalate",
            escalate_to_claude=True,
            context={
                "gap_days": gap,
                "recent_energy": trigger.user_state["energy"],
                "recent_mood": trigger.user_state["mood"]
            }
        )
```

### Goal & Commitment Behaviours

```python
# Triggered if event is overdue
async def overdue_episode_check(ctx, trigger):
    """Flag overdue commitments."""
    overdue = await ctx.db.query(
        "SELECT * FROM events WHERE due_at < NOW() AND status != 'done'"
    )
    if overdue:
        return BehaviourResult(
            action="note",
            message=f"Overdue: {', '.join(e.title for e in overdue)}",
            escalate_to_claude=True
        )

# Triggered if user has > 5 active goals/projects
async def scope_drift_check(ctx, trigger):
    """Alert if user is overcommitted."""
    active_count = await ctx.db.query(
        "SELECT COUNT(*) FROM episodes WHERE status = 'active'"
    )
    if active_count > 5:
        return BehaviourResult(
            action="escalate",
            escalate_to_claude=True,
            context={"active_count": active_count}
        )
```

### Idea Brainstorming Behaviours

```python
# Triggered if ideas shelf has new captures
async def idea_brainstorm_check(ctx, trigger):
    """Suggest adjacent ideas to explore."""
    recent_ideas = await ctx.db.query(
        "SELECT * FROM captures WHERE created_at > NOW() - INTERVAL '7 days'"
    )
    if len(recent_ideas) > 2:
        return BehaviourResult(
            action="escalate",
            escalate_to_claude=True,
            context={
                "ideas": [i.raw_text for i in recent_ideas],
                "request": "Brainstorm which ideas are adjacent and worth exploring together?"
            }
        )
```

### Interest-Based Behaviours (MCP integration)

```python
# Triggered on schedule (e.g., daily)
async def interests_monitor(ctx, trigger):
    """Check for LEGO/LOTR deals, new releases, etc."""
    interests = await ctx.db.query(
        "SELECT interests FROM user_context WHERE key = 'interests'"
    )
    # Use MCP tools to query eBay, LEGO store, etc.
    ebay_results = await ctx.mcp.call("ebay.search", query="LEGO LOTR Barad-dûr")
    if ebay_results:
        return BehaviourResult(
            action="nudge",
            message=f"Found {len(ebay_results)} new LEGO listings matching your interests.",
            data=ebay_results[:3]
        )
```

### Self-Reflection Behaviours

```python
# Triggered on schedule (e.g., weekly)
async def agent_reflection(ctx, trigger):
    """Reflect on agent role, improvements, feedback."""
    feedback = await ctx.db.query(
        "SELECT * FROM feedback WHERE created_at > NOW() - INTERVAL '7 days'"
    )
    return BehaviourResult(
        action="escalate",
        escalate_to_claude=True,
        context={
            "question": "Who am I? What's my role? How can I get better?",
            "agent_context": trigger.agent_context,
            "recent_behaviours": trigger.recent_behaviours,
            "user_feedback": feedback
        }
    )
```

---

## Configuration

### Sentry Plugin YAML

```yaml
schema: 1
name: sentry
version: 0.1.0
display_name: Sentry — Continuous Thinking Loop
description: >
  Always-on agentic loop that observes state, goals, and memory
  to proactively steer without waiting for user prompts.

tier: core
license: AGPL

depends_on: []

host:
  eidan: ">=0.1.0"
  python: ">=3.11"

env:
  - name: SENTRY_ENABLED
    required: false
    default: "0"
  - name: SENTRY_TICK_INTERVAL_SECONDS
    required: false
    default: "300"  # 5 minutes
  - name: SENTRY_MODEL
    required: false
    default: "phi-3-mini"  # local inference
  - name: SENTRY_ESCALATION_BUDGET
    required: false
    default: "3"  # max Claude calls per day

vault: []

backend:
  entrypoint: sentry.plugin:Plugin
  routes_prefix: /api/plugins/sentry

frontend:
  package: ./web
  routes:
    - path: /sentry
      component: ./web/src/pages/Sentry.tsx
  components:
    - slot: dashboard.widget
      component: ./web/src/widgets/SentryStatus.tsx

migrations:
  dir: ./migrations
  driver: alembic

behaviours:
  - id: sentry.wellness_check
    trigger: schedule:PT5M  # every 5 minutes
    handler: sentry.behaviours:wellness_check
  - id: sentry.nutrition_gap_check
    trigger: schedule:PT15M
    handler: sentry.behaviours:nutrition_gap_check
  - id: sentry.overdue_episode_check
    trigger: schedule:PT10M
    handler: sentry.behaviours:overdue_episode_check
  - id: sentry.scope_drift_check
    trigger: schedule:PT30M
    handler: sentry.behaviours:scope_drift_check
  - id: sentry.idea_brainstorm_check
    trigger: cron:0 9 * * *  # daily at 9am
    handler: sentry.behaviours:idea_brainstorm_check
  - id: sentry.interests_monitor
    trigger: cron:0 8 * * 0  # weekly on Sunday
    handler: sentry.behaviours:interests_monitor
  - id: sentry.agent_reflection
    trigger: cron:0 7 * * 0  # weekly on Sunday
    handler: sentry.behaviours:agent_reflection

mcp:
  enabled: true
  name: sentry
  entrypoint: sentry.mcp:server
  transport: stdio
  tools:
    - sentry.query_state
    - sentry.escalate_to_claude
```

---

## Data Model

### Core Tables (in `plugin_sentry` schema)

```sql
-- Sentry tick log (one row per loop iteration)
CREATE TABLE sentry_ticks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  tick_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  state JSONB NOT NULL,  -- user_mood, energy, stress_signals, etc.
  patterns_detected TEXT[],  -- ["stress_cycle", "nutrition_gap", ...]
  actions_taken TEXT[],  -- ["nudge", "escalate", "note", ...]
  escalations_queued INT DEFAULT 0,
  error TEXT
);

-- Sentry nudges (user-facing messages)
CREATE TABLE sentry_nudges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  tick_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  channel TEXT,  -- "telegram", "note", "event", ...
  message TEXT NOT NULL,
  data JSONB,  -- e.g., eBay listings, brainstorm ideas
  dismissed_at TIMESTAMPTZ
);

-- Escalation jobs (async Claude calls)
CREATE TABLE sentry_escalations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  tick_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  pattern TEXT,  -- "stress_cycle", "nutrition_gap", ...
  context JSONB NOT NULL,
  status TEXT,  -- "pending", "running", "done", "failed"
  result JSONB,
  error TEXT
);
```

---

## Hive Brain (Multi-Node)

When multiple sentry nodes run (e.g., Pi + cloud instance):

1. **State sharing:** All nodes read from the same Postgres, so they see the same `user_context`, `events`, `notes`.
2. **Coordination:** A lightweight leader-election mechanism (via Postgres advisory lock) ensures only one node runs each scheduled behaviour at a time.
3. **Escalation queue:** Escalations are written to `sentry_escalations` by any node; a dedicated worker (or the leader) processes them.
4. **Feedback loop:** Sentry nudges and Claude responses are written back to `notes` / `events`, visible to all nodes and the main agent.

---

## Cost & Performance

### Hardware (Pi 5 4GB)

| Component | Memory | Notes |
|-----------|--------|-------|
| OS (Raspberry Pi OS Lite) | ~200MB | Minimal headless |
| Ollama + Phi-3 mini (3.8B Q4) | ~2.5GB | Quantized, fits comfortably |
| Python FastAPI sentry loop | ~300MB | Lightweight event loop |
| Postgres connection + query buffer | ~200MB | Single connection, small result sets |
| **Headroom** | ~800MB | Safe margin for spikes |

### Inference Cost

- **Phi-3 inference:** ~1–2 seconds per tick, runs locally (no API cost).
- **Electricity:** ~0.1 kWh/day = **£0.01/month**.
- **Claude escalations:** ~2–3 per week (configurable budget) = **£0.50–2/month**.
- **Total:** **£2–3/month** (vs. £50–200/month if Claude ran every tick).

### Latency

- **Tick latency:** ~2–5 seconds (query state + Phi-3 inference + write results).
- **Escalation latency:** ~10–30 seconds (async, doesn't block the loop).
- **Nudge delivery:** ~1 second (Telegram API).

---

## Safety & Guardrails

1. **No autonomous actions:** The sentry only **suggests** and **nudges**. It never:
   - Deletes or modifies user data without explicit approval.
   - Sends emails or messages on behalf of the user.
   - Makes financial decisions.

2. **Batching:** Nudges are batched (max 1 per hour per pattern) to avoid alert fatigue.

3. **Escalation budget:** Configurable max Claude calls per day (default 3) to prevent runaway costs.

4. **Idempotency:** All behaviour handlers are idempotent on `trigger.idempotency_key` to tolerate retries.

5. **Dead-letter queue:** Failed behaviours land in a dead-letter table surfaced in the admin UI.

6. **Privacy:** All data stays local (on the Pi or within the user's infrastructure). Escalations to Claude include only the minimal context needed.

---

## Implementation Phases

### Phase 1 (MVP)
- [ ] Sentry core loop (tick, state query, pattern match, decide).
- [ ] Phi-3 local inference via Ollama.
- [ ] Basic behaviours: wellness check, nutrition gap, overdue episodes.
- [ ] Telegram nudge delivery.
- [ ] Escalation to Claude (async job queue).

### Phase 2
- [ ] Hive brain (multi-node coordination).
- [ ] More behaviours: scope drift, idea brainstorming, interests monitor.
- [ ] MCP integration for external queries (eBay, LEGO store, email).
- [ ] Web UI dashboard for sentry status and nudge history.

### Phase 3
- [ ] Self-reflection behaviours (agent improvement feedback).
- [ ] Adaptive tick interval (faster when stress detected, slower when calm).
- [ ] Context summarization (compress old notes to stay within token budget).

---

## Success Criteria

- [ ] Sentry runs continuously on Pi 5 4GB without memory issues.
- [ ] Detects stress cycle step 1–2 within 1 tick (5–15 min).
- [ ] Flags nutrition gaps within 2 ticks of logging stopping.
- [ ] Suggests adjacent ideas when idea shelf grows.
- [ ] Escalates complex patterns to Claude with < 1 min latency.
- [ ] Nudges are useful and not spammy (user dismisses < 10% of nudges).
- [ ] Total cost stays under £5/month.

---

## Open Questions

1. **Phi-3 vs. Mistral 7B:** Phi-3 is lighter (3.8B); Mistral 7B is more capable (7B). Trade-off?
2. **Tick interval:** 5 min (responsive) vs. 15 min (battery-friendly)? Adaptive?
3. **Escalation criteria:** When exactly should a pattern escalate to Claude? Heuristics vs. another classifier?
4. **Nudge channels:** Telegram only, or also email, in-app notifications, voice?
5. **Plugin dependencies:** Should sentry require wellness, calendar, ideas plugins, or work standalone?

---

**Maintained by:** Sielay Ltd  
**Last updated:** 2026-05-19
