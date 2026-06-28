# Agent Skills System

This documents the agent skills system (v1.0), which lets agents reference reusable prompt content via `[skill: NAME]` syntax in their personas.

## Available Skills

Agents can reference built-in skills to include well-tested guidance on core rules and function call reliability:

## How It Works

Agents reference skills in their persona text:

```
[skill: Agent Foundation]
[skill: Function Call Hardening]

Your task: review emails and summarize daily changes.
```

When the agent fires, the runner expands these references to their full content before sending to the provider.

### `agent-foundation` (v1.0)
Core behavioral rules and tool discipline for all agents.

**Contents:**
- Core Directive: Be a WORKER, not an orchestrator
- Hard Rules: Don't create agents/jobs unless it's your task; do the work yourself
- Tool Categories: Execution tier (safe), Orchestration tier (forbidden), Signal tier (escalations)
- State Management: Conversations write-once, memory append-only, escalations notify humans
- Provider Notes: Tips for Claude, DeepSeek, OpenAI

**When to use:** Include in agents that need core behavioral rules and tool discipline.

**Example reference:**
```
[skill: Agent Foundation]

Your task: review emails and summarize daily changes.
```

### `function-call-hardening` (v1.0)
Provider-specific tips for reliable function calls.

**Contents:**
- JSON Validation: required fields, type checking, escaping, nested objects
- DeepSeek-Specific: stricter validation, one tool per response, explicit "you MUST call"
- Parameter Naming: case-sensitivity, enum validation, array handling
- Recovery Patterns: what to do on failure, retry strategy, when to escalate

**When to use:** Include for agents that call tools frequently or run on multiple providers.

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
- On each fire, runner expands `[skill: X]` → full content before sending to provider

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

## Documentation

- **EXAMPLES.md** — Reference agents using the new skill system (daily digest, email summarizer, monitoring)
- **src/skills/agent-foundation.ts** — Core worker rules
- **src/skills/function-call-hardening.ts** — Provider-specific function call guidance

## Future Enhancements

1. **Operator-owned skills:** Allow operators to define custom skills in deploy config
2. **Skill versioning:** `[skill: Agent Foundation v1.1]` with explicit version pinning
3. **Multi-skill composition:** `[skills: foundation, hardening, custom-monitoring]` in one reference
4. **Skill validation:** Lint new skills before deployment (e.g., no hardcoded names, no secrets)
5. **Skill tagging:** Categorize skills (rules, examples, debugging, provider-specific) for discovery

## Questions & Decisions

### Why not use matbot's KnowledgeIndex?

matbot's `KnowledgeIndex` is for long-term learned knowledge (notes, facts, decision logs) that agents recall during execution. Skills are **foundational rules** that frame every execution, not learned knowledge. They're more like system prompts than memories.

### Can operators define custom skills?

**Phase 1:** No. Only built-in skills.  
**Phase 2:** Yes, via `agent-cache-config.json` in the deploy directory.  
**Phase 3:** Yes, with versioning and sharing.

### Does this work with local Ollama?

Yes. Skills still expand and work normally with any provider.

### Can I reference the same skill twice?

```
[skill: Agent Foundation]
[skill: Agent Foundation]
```

This expands both references to the full content, doubling the text. Don't do this. Deduplicate in persona or describe once.

### What about prompt injection in skill references?

The skill reference pattern `[skill: NAME]` is simple string-matching. NAME is validated against `BUILTIN_SKILLS`. If someone puts `[skill: ../../../etc/passwd]` or weird Unicode, it just won't match and the reference stays as-is (untouched). No injection risk.

## Support & Issues

- **Questions about skills?** See EXAMPLES.md.
- **Want to add a skill?** Update `src/skills/index.ts` and test `expandSkillReferences()`.
- **Bugs in expansion logic?** File an issue with the persona text and expected result.
