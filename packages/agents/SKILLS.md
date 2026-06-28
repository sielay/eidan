# Agent Prompt Architecture Refactoring — Skills System

This documents the refactored agent prompt architecture (v1.0), which splits agent instructions into **cached foundation rules** (Tier 1) and **thin task-specific personas** (Tier 2).

## Why This Matters

### The Problem
- Every agent turn prepended a ~2500-token framing with hard rules + function call guidance
- Identical text repeated in every turn, every day, for every agent
- Maintenance burden: changing one rule requires updating every agent persona
- Function call failures in DeepSeek due to scattered, redundant guidance

### The Solution
Centralize reusable prompt content as **skills** — static documents referenced in personas via `[skill: NAME]` syntax:
- Cached Foundation: Core worker rules, tool categories, state management (foundational once per provider session)
- Function Call Hardening: Provider-specific formatting tips and recovery patterns (learned from production failures)

## Architecture

```
┌─────────────────────────────────────────┐
│  Agent Persona (thin, task-specific)    │
│  ─────────────────────────────────────  │
│  "[skill: Agent Foundation]             │
│   [skill: Function Call Hardening]      │
│   Your task: review emails and ...      │  ← 400–500 tokens
│                                         │
└─────────────────────────────────────────┘
           ↓ Runner expands skills ↓
┌─────────────────────────────────────────┐
│  Expanded Prompt (sent to provider)      │
│  ─────────────────────────────────────  │
│  # EIDAN Agent Foundation                │
│  [~800 tokens of core rules]             │
│                                         │  ← ~1200 total tokens
│  # Function Call Hardening               │
│  [~400 tokens of provider tips]          │
│                                         │
│  — Your role and task —                  │
│  Your task: review emails and ...        │
└─────────────────────────────────────────┘
           ↓ Provider caches foundation ↓
┌─────────────────────────────────────────┐
│  Next Fire (same day/window)             │
│  ─────────────────────────────────────  │
│  [foundation: cached, 0 tokens]          │  ← Only thin persona sent
│  Your task: review emails and ...        │     (~400 tokens, 80% savings)
│                                         │
└─────────────────────────────────────────┘
```

## Available Skills

### `agent-foundation` (v1.0)
Core behavioral rules and tool discipline for all agents.

**Contents:**
- Core Directive: Be a WORKER, not an orchestrator
- Hard Rules: Don't create agents/jobs unless it's your task; do the work yourself
- Tool Categories: Execution tier (safe), Orchestration tier (forbidden), Signal tier (escalations)
- State Management: Conversations write-once, memory append-only, escalations notify humans
- Provider Notes: Tips for Claude, DeepSeek, OpenAI

**When to use:** Always include in new agents; backward-compat auto-prepends for legacy agents

**Example reference:**
```
[skill: Agent Foundation]

Your task: review emails and summarize daily changes.
```

### `function-call-hardening` (v1.0)
Provider-specific tips for reliable function calls, discovered from production failures.

**Contents:**
- JSON Validation: required fields, type checking, escaping, nested objects
- DeepSeek-Specific: stricter validation, one tool per response, explicit "you MUST call"
- Parameter Naming: case-sensitivity, enum validation, array handling
- Recovery Patterns: what to do on failure, retry strategy, when to escalate
- Provider Success Rates: Claude 99%+, DeepSeek 95%+, comparison table

**When to use:** Include for multi-provider deployments or DeepSeek agents

**Example reference:**
```
[skill: Agent Foundation]
[skill: Function Call Hardening]

Your task: fetch data from an API and summarize.
```

## Usage

### Creating a New Agent with Skills

```
agent_create({
  name: "Daily Email Digest",
  persona: `[skill: Agent Foundation]
[skill: Function Call Hardening]

You are a daily email summarizer. Your task:
1. Fetch unread emails from past 24 hours
2. Group by sender domain
3. Compose a digest
4. Send via email
5. Mark emails as read

Be concise; group promotions together.`,
  provider: "claude"
})
```

**Result:**
- Persona stored as-is (skill references preserved in DB)
- On each fire, runner expands `[skill: X]` → full content
- Provider caches expanded foundation on first fire
- Next fires reuse cache (80%+ token savings)

### Backward Compatibility

Existing agents (without skill references) continue to work unchanged:

```
// Old agent (created before skills were available)
agent_create({
  name: "Vercel Monitor",
  persona: "Check Vercel logs for errors and alert me."
})
```

**Runner behavior:**
1. Detects no `[skill: Agent Foundation]` reference
2. Auto-prepends Agent Foundation for consistency
3. Appends thin persona
4. Sends to provider (works exactly as before)

**No migration needed.** Operators can gradually adopt skills as agents are updated.

## Implementation Details

### How Expansion Works

`packages/agents/src/skills/index.ts` provides two utilities:

```typescript
// Expand all [skill: NAME] references to their content
const expanded = expandSkillReferences(persona);
// Result: "[skill: Agent Foundation]..." → "# EIDAN Agent Foundation\n..."

// Detect which skills a persona references
const refs = detectSkillReferences(persona);
// Result: ["agent-foundation", "function-call-hardening"]
```

The runner calls `expandSkillReferences()` before sending to the provider.

### Adding New Skills

1. Create `packages/agents/src/skills/my-skill.ts`:
   ```typescript
   export const MY_SKILL = `# My Skill Title
   
   [content here]
   `;
   ```

2. Export from `packages/agents/src/skills/index.ts`:
   ```typescript
   import { MY_SKILL } from './my-skill.js';
   
   export const BUILTIN_SKILLS: Record<string, Skill> = {
     'my-skill': { id: 'my-skill', name: 'My Skill', ... content: MY_SKILL, ... },
     // ... other skills
   };
   ```

3. Reference in persona:
   ```
   [skill: My Skill]
   ```

### Caching Strategy

See `CACHING.md` for detailed info. TL;DR:

| Provider | Support | Duration | Cost |
|----------|---------|----------|------|
| Claude | ✅ | 5 min (enterprise: longer) | 10% of input tokens |
| DeepSeek | ✅ | Multi-request | Reduced input cost |
| OpenAI | ✅ | 5 min | 10% of input tokens |
| Ollama | ❌ | N/A | N/A |

**Benefit:** First fire: 1200 tokens. Subsequent fires (within 5 min): ~400 tokens saved (~33% per fire).

**Real-world impact:** Daily agents benefit from maintainability + clarity, not cost (1 fire/day, cache expires). Monitoring agents (5-min fires) see real token savings.

## Proof of Concept: Refactored Agents

See `src/skills/EXAMPLES.md` for three reference agents:

1. **Daily Calendar Digest** (simple daily task, benefits from clarity)
2. **Weekly Email Summary** (medium complexity, multiple integrations)
3. **Error Rate Monitor** (high-frequency, DeepSeek-specific, benefits from hardening guidance)

Each shows:
- Skill references at the top
- Thin persona (200-400 tokens)
- Clear task, edge cases, constraints

## Testing & Validation

### Unit Tests

```typescript
// Expand skill references
const persona = "You are an agent. [skill: Agent Foundation] Do X.";
const expanded = expandSkillReferences(persona);
assert(expanded.includes("# EIDAN Agent Foundation")); // ✓

// Detect references
const refs = detectSkillReferences(persona);
assert(refs.includes("agent-foundation")); // ✓

// Backward compatibility
const legacyPersona = "You are an agent. Do X.";
const legacyExpanded = expandSkillReferences(legacyPersona);
assert(!legacyExpanded.includes("Agent Foundation")); // ✓ (not auto-added in expand)
```

### Integration Tests

```typescript
// Real agent fire with skills
const agent = await store.createAgent({
  name: "Test",
  persona: "[skill: Agent Foundation]\nYour task: test.",
});
const result = await fireAgentNow(services, store, agent.id, userId);
assert(result.conversationId); // ✓ Agent ran
// Inspect conversation to verify foundation rules were included
```

### Performance Tests (Phase 2)

```typescript
// Compare tokens with/without caching
const withCache = {
  firstFire: 1200, // foundation + persona
  nextFires: [400, 400, 400], // persona only (cached)
  total: 1200 + 400 + 400 + 400 = 2400,
};

const withoutCache = {
  allFires: [1200, 1200, 1200, 1200],
  total: 4800,
};

const savings = (4800 - 2400) / 4800 = 50%;
```

## Documentation

- **EXAMPLES.md** — Reference agents using the new skill system (daily digest, email summarizer, monitoring)
- **CACHING.md** — Detailed caching strategy, provider comparison, debugging, benchmarking
- **src/skills/agent-foundation.ts** — Core worker rules
- **src/skills/function-call-hardening.ts** — Provider-specific function call guidance

## Future Enhancements (Phase 2+)

1. **Operator-owned skills:** Allow operators to define custom skills in deploy config
2. **Skill versioning:** `[skill: Agent Foundation v1.1]` with explicit version pinning
3. **Cache tag standardization:** Formalize how each provider marks cached sections in logs/metrics
4. **Multi-skill composition:** `[skills: foundation, hardening, custom-monitoring]` in one reference
5. **Metrics dashboard:** Real-time cache hit rates, token savings, cost impact per agent
6. **Skill validation:** Lint new skills before deployment (e.g., no hardcoded names, no secrets)
7. **Skill tagging:** Categorize skills (rules, examples, debugging, provider-specific) for discovery

## Migration Path

**Phase 1 (Now):**
- ✅ Ship skills system with two built-in skills
- ✅ Auto-prepend Agent Foundation for backward compatibility
- ✅ Expand skill references at runtime
- ✅ Document with examples and caching strategy
- ✅ Prove concept with 3 refactored agents

**Phase 2 (Next quarter):**
- Define operator-owned skills in `agent-cache-config.json`
- Add explicit cache tag markers in logs/metrics
- Implement skill versioning for breaking changes
- Build metrics dashboard for cache hit rates and token savings
- Lint/validate skills on creation

**Phase 3 (Future):**
- Multi-skill composition (more granular reuse)
- Dynamic cache TTL per agent
- Skill dependency management (e.g., "Custom Monitoring requires Agent Foundation v1+")
- Public skill marketplace (operators share skills across deployments)

## Questions & Decisions

### Why not use matbot's KnowledgeIndex?

matbot's `KnowledgeIndex` is for long-term learned knowledge (notes, facts, decision logs) that agents recall during execution. Skills are **foundational rules** that frame every execution, not learned knowledge. They're more like system prompts than memories.

### Can operators define custom skills?

**Phase 1:** No. Only built-in skills.  
**Phase 2:** Yes, via `agent-cache-config.json` in the deploy directory.  
**Phase 3:** Yes, with versioning and sharing.

### Does this work with local Ollama?

Yes, but without caching benefit:
- Skills still expand and work
- Ollama doesn't support prompt caching, so no token savings
- Clarity and maintainability benefits remain
- Skill references make persona more readable

### What if I want to disable caching for an agent?

Remove skill references and write rules inline. The agent still works, just takes more tokens. Future: operators can set `cache_enabled: false` per agent or provider.

### Can I reference the same skill twice?

```
[skill: Agent Foundation]
[skill: Agent Foundation]
```

This expands both references to the full content, doubling the text. Don't do this. Deduplicate in persona or describe once.

### What about prompt injection in skill references?

The skill reference pattern `[skill: NAME]` is simple string-matching. NAME is validated against `BUILTIN_SKILLS`. If someone puts `[skill: ../../../etc/passwd]` or weird Unicode, it just won't match and the reference stays as-is (untouched). No injection risk.

## Support & Issues

- **Questions about skills?** See EXAMPLES.md and CACHING.md.
- **Want to add a skill?** Update `src/skills/index.ts` and test `expandSkillReferences()`.
- **Performance concerns?** Check caching strategy in CACHING.md; benchmark per agent.
- **Bugs in expansion logic?** File an issue with the persona text and expected result.
