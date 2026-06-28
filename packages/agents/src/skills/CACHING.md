# Prompt Caching Strategy for Agent Skills

This document explains how prompt caching works with the new two-tier agent prompt architecture, and how to configure it per provider.

---

## The Caching Opportunity

Agent skills (Agent Foundation, Function Call Hardening) are **static, reusable content** that gets prepended to every agent fire. Providers like Claude, DeepSeek, and OpenAI support prompt caching, which means:

1. **First fire:** Operator's model processes the full cached skill + thin persona (normal cost)
2. **Second+ fires:** Provider returns cached foundational content for free, only bills for the thin persona

**Impact for daily agents (8 fires/day, 365 days):**
- Old system: 365 × 8 × 2500 tokens = 7.3M tokens/year
- New system: 1 × 2500 + (365 × 8 - 1) × 500 tokens = 1.46M tokens/year (**80% savings**)

---

## Provider Support

| Provider | Caching | Method | Cache Window |
|----------|---------|--------|--------------|
| **Claude** (Anthropic) | ✅ Yes | `cache_control: {"type": "ephemeral"}` header on system messages | 5 minutes (can be longer with enterprise pricing) |
| **DeepSeek** | ✅ Yes | Special comment markers in system prompt | Multi-request window (enterprise: 1 hour+) |
| **OpenAI** (GPT-4) | ✅ Yes | `cache_control: {"type": "ephemeral"}` in system messages | 5 minutes |
| **OpenRouter** (Claude relay) | ✅ Yes | Proxies Claude's cache control | Same as upstream (Claude) |
| **Local Ollama** | ❌ No | Not supported | N/A |
| **Older Claude models** (3.0) | ❌ No | Not supported | N/A |

---

## How Caching Works in Eidan Agents

### Current Implementation (Phase 1)

1. Skills are static TypeScript exports (no state, no TTL)
2. Runner expands skill references in persona at execution time
3. Provider receives: `[skill_content]\n[thin_persona]`
4. Provider caches `[skill_content]` if it supports caching

### Marking Cached Sections

Currently, we rely on provider adapters to mark cached sections. In the future, we'll add explicit markers:

```
<!-- cached: agent-foundation v1.0 cache_duration=300 -->
[skill_content]
<!-- end cached -->
```

Providers will:
- Claude: Wrap in `cache_control` header
- DeepSeek: Add special tag (TBD per DeepSeek SDK)
- OpenAI: Use system message structure

### No Per-Provider Config Yet

Currently, caching is **automatic** for all providers that support it (no operator knob). If needed, operators can:
1. Disable caching for an agent by removing skill references
2. Use a provider that doesn't cache (e.g., local Ollama) for testing
3. (Future) Set `cache_enabled: false` in agent config

---

## Cache Invalidation & Versioning

### When Cache Invalidates

1. **Time-based:** 5 minutes for most providers (cache_control: ephemeral)
2. **Content-based:** If skill version changes, cache is implicitly invalidated
3. **Provider restart:** Cache cleared

### Versioning Strategy (Phase 2)

When we need to update Agent Foundation (e.g., new hard rules):

```
Version 1.0 (current):
  "Do NOT create agents except for agent-meta tasks"

Version 1.1 (hypothetical future):
  "Do NOT create agents except for agent-meta tasks. New rule: Always validate inputs before calling tools."
```

Operators reference by version:
```
[skill: Agent Foundation v1.0]  # Explicit version
[skill: Agent Foundation]        # Auto-latest (v1.0 now, v1.1 on next release)
```

---

## Debugging & Observability

### Logging

When `runAgentTurn()` executes, it logs:

```
[agents] agent="Daily Calendar" firing
  skills_referenced=["agent-foundation", "function-call-hardening"]
  provider="claude" cache_support="yes"
  cache_key="agent-foundation_v1.0|function-call-hardening_v1.0"
  persona_tokens=450 skills_tokens=~1200
```

On next fire (cache hit):
```
[agents] agent="Daily Calendar" firing (cache_hit)
  cache_key="agent-foundation_v1.0|function-call-hardening_v1.0"
  persona_tokens=450 skills_tokens=0 (cached)
```

### Metrics (Future)

Track in `eidan.llm_calls`:
- `cached_input_tokens` vs `input_tokens`
- Cache hit rate per agent per provider
- Cost savings per agent per week

---

## Cache Behavior by Provider

### Claude (Anthropic)

**Cache Control Header:**
```json
{
  "type": "text",
  "text": "[skill_content]\n[thin_persona]",
  "cache_control": {"type": "ephemeral"}
}
```

**Cache Duration:** 5 minutes (enterprise: longer with negotiated terms)

**Cost:**
- Cached input tokens: 10% of normal cost (or free, depending on plan)
- Output tokens: always full cost

**Best For:** Agents firing multiple times per 5-minute window (not common for daily agents, but common for monitoring agents)

### DeepSeek

**Caching Method:** System prompt structure with special markers (implementation TBD)

**Cache Duration:** Multi-request window; enterprise plans may offer 1 hour

**Cost:** Reduced input token cost for cached sections (similar to Claude)

**Gotcha:** DeepSeek may require explicit markers in the system prompt; verify with SDK docs

### OpenAI

**Cache Control Header:** Similar to Claude (use system message)

**Cache Duration:** 5 minutes

**Cost:** Same as Claude

**Note:** Must use GPT-4o or later; older models don't support caching

---

## Trade-offs & Limitations

### Why Not Cache Longer?

1. **Model updates:** OpenAI/Claude/DeepSeek may update models, invalidating long-lived caches
2. **Stale rules:** If we update Agent Foundation, long-lived caches serve old rules
3. **Cost:** Longer TTL incurs higher cache storage costs with some providers

**Decision:** Use default ephemeral caching (5 min) for Phase 1. Move to 1-hour+ only if operators request and accept the trade-offs.

### Why Caching Works for Skills but Not for Full Conversations

1. **Skills are static:** Same content every fire
2. **Personas are dynamic:** Different per agent, changes over time
3. **Conversations are unique:** Every chat is new; context doesn't repeat

Thus: Cache skills (foundation rules), not personas.

### When Caching Doesn't Help

- **First-fire agents:** New agents (created by operators) see no cache benefit on turn 1
- **Rarely-firing agents:** Agents with >5 min between fires miss cache windows
- **Long gaps:** Monthly agents (e.g., monthly digest) won't benefit (cache expires)

---

## Configuration (Phase 2)

Future operators can control caching via `agent-cache-config.json`:

```json
{
  "agents": {
    "daily-digest": { "cache": true, "cache_ttl_seconds": 300 },
    "monthly-report": { "cache": false },
    "realtime-monitor": { "cache": true, "cache_ttl_seconds": 3600 }
  },
  "providers": {
    "claude": { "cache_enabled": true },
    "deepseek": { "cache_enabled": true },
    "ollama": { "cache_enabled": false }
  },
  "default": { "cache_enabled": true }
}
```

**Current (Phase 1):** Caching is always enabled for agents with skill references; disabled for legacy agents (backward compatible).

---

## Benchmarking

To measure actual savings:

1. **Track pre- and post-refactor tokens** for a week of agent runs
2. **Calculate cache hit ratio:**
   ```
   cache_hits / total_fires
   ```
3. **Estimate savings:**
   ```
   (cached_tokens_saved * cost_per_1k) × (1 - hit_ratio) 
   ```

Example:
```
Agent: Daily Calendar
Provider: Claude
Cached foundation: ~1200 tokens
Thin persona: ~450 tokens
Daily fires: 1 (no cache benefit)
Weekly fires: 7
Cache window: 5 minutes (expires before next day)

Actual savings: 0% (cache always expires before next fire)
Recommendation: Skills help with clarity and maintainability, but not with token cost for daily agents.

Agents that benefit from caching:
- Monitoring agents (fire every 5 min; same day cache hits)
- Batch jobs (multiple instances of same agent per day)
```

---

## Future Enhancements

1. **Provider-agnostic cache markers:** Standardize how we mark cached sections so any provider can use them
2. **Dynamic cache TTL:** Operators set per-agent cache duration
3. **Cache strategy selection:** "ephemeral" vs "persistent" (if providers support)
4. **Multi-skill batching:** Cache multiple skills together for agents that reference many
5. **Skill composition:** Agents combine foundational + custom skills, all cached as one unit
6. **Metrics dashboard:** Real-time cache hit rates and cost savings per agent/provider/day

---

## Testing & Validation

### Unit Tests (Phase 1)

- `expandSkillReferences()` correctly replaces `[skill: NAME]` patterns
- `detectSkillReferences()` finds all references in a persona
- Backward compatibility: legacy personas (no skill references) still work

### Integration Tests (Phase 1)

- Agent fires with explicit skill references → skills are expanded
- Agent fires without skill references → Agent Foundation auto-prepended
- Multiple skill references in one persona → all expanded

### Performance Tests (Phase 2)

- Measure first-fire tokens vs cached-fire tokens
- Verify cache hit rates match provider expectations
- Estimate cost savings per agent per month

### Provider-specific Tests (Phase 2)

- Claude: Verify cache_control header is respected
- DeepSeek: Verify caching markers work
- OpenAI: Verify system message caching works
