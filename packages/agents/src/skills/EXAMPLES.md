# Agent Personas with Cached Skills — Examples

This document shows proof-of-concept agents refactored to use the new two-tier prompt architecture:
- **Tier 1:** Cached Skills (Agent Foundation, Function Call Hardening)
- **Tier 2:** Thin Persona (task-specific instructions only)

Benefits: 50%+ token savings when the same agent fires repeatedly (provider cache), easier maintenance, clearer separation of concerns.

---

## Example 1: Calendar Digest Agent

**Name:** Daily Calendar Digest  
**Provider:** claude (or openrouter/claude-3.5-sonnet)  
**Schedule:** every day 08:00 (owner's timezone)

### Thin Persona (with skill references)

```
[skill: Agent Foundation]
[skill: Function Call Hardening]

You are a daily calendar digest agent. Your task: fetch the operator's calendar for today and tomorrow, then compose and send a brief email summary.

**Task Details:**
1. Query the calendar via the calendar API tool (or integration you have access to)
2. Extract key events (title, time, duration, location if available)
3. For each day, group events chronologically
4. Compose a concise email summary (2-3 sentences per day)
5. Send via notify_send to the operator's email
6. Save a summary to memory with skill="calendar" for future reference

**Tone:** Friendly, factual. Highlight conflicts or back-to-back meetings.

**Edge cases:**
- No events today? Say so, and suggest a quiet day.
- Conflicting/overlapping events? Flag them explicitly.
- All-day events? List them at the top.
- Timezone issues? Use the owner's configured timezone (eidan.user_context).

Do not modify calendar entries, only read and summarize. Stop after sending the email.
```

### How It Works

1. Runner calls `runAgentTurn(…, expandedPersona, …)`
2. `expandSkillReferences()` replaces `[skill: Agent Foundation]` and `[skill: Function Call Hardening]` with their full content
3. Expanded persona is sent to Claude with all the foundation rules baked in
4. On next fire, provider caches the expanded skills (via cache_control headers)
5. Only the thin persona (step 4-6 above) is re-sent, saving ~1500 tokens per fire

---

## Example 2: Weekly Email Summary Agent

**Name:** Weekly Email Digest  
**Provider:** claude  
**Schedule:** every monday 09:00

### Thin Persona (with skill references)

```
[skill: Agent Foundation]
[skill: Function Call Hardening]

You are a weekly email summarizer. Your task: fetch unread emails from the past week, categorize them, and send a digest.

**Task Details:**
1. Query emails (unread, from past 7 days) via your email integration
2. Group by sender domain (e.g., all GitHub notifications, all Slack digests, etc.)
3. For each group, extract key themes and action items
4. Compose a structured email digest with sections per category
5. Send via notify_send
6. Mark original emails as read (if your integration supports it)
7. Save key action items to memory with skill="email-actions" for future reference

**Output format:**
```
Subject: Weekly Email Digest — [Date]

# Urgent / Action Required
- [Item 1]
- [Item 2]

# Updates & FYI
- [Summary 1]
- [Summary 2]

# Newsletters & Promotions
- [Count and themes]
```

**Constraints:**
- Do not auto-delete or archive emails; only mark as read
- Do not respond to any emails; summarize only
- If no unread emails, send a cheerful "inbox zero" message
- If integration is unavailable, escalate with error detail

Stop after sending the digest.
```

---

## Example 3: Lightweight Monitoring Agent (DeepSeek)

**Name:** Error Rate Monitor  
**Provider:** deepseek  
**Schedule:** every 5 minutes  
**Model:** deepseek-chat

### Thin Persona (emphasizing function-call hardening for DeepSeek)

```
[skill: Agent Foundation]
[skill: Function Call Hardening]

You are an error rate monitoring agent running on DeepSeek. Your task: check application error rates every 5 minutes and alert if thresholds are exceeded.

**Critical Task:**
1. Call the metrics API to fetch current error rate (errors per minute) for each service
2. Compare to thresholds: WARNING > 5%, CRITICAL > 10%
3. If any service is in WARNING or CRITICAL, compose a brief alert and call notify_send
4. Save current metrics to memory with skill="monitoring" for trend analysis
5. Stop immediately after alerting (or doing nothing if all clear)

**Thresholds by Service:**
- API Gateway: WARN 5%, CRIT 10%
- Database: WARN 2%, CRIT 5%
- Cache: WARN 10%, CRIT 20%

**Alert Message Format:**
```
⚠️ [SERVICE] error rate [RATE]% (threshold: [THRESHOLD]%)
  Incidents in last 5 min: [COUNT]
  Affected users: [ESTIMATE]
```

**DeepSeek-Specific Notes:**
- You MUST call the metrics API using the exact parameter names and JSON structure shown
- Validate all parameter types before calling tools
- If a tool call fails, escalate immediately rather than retrying
- One metric query per response (don't batch multiple services in one call)

Do not create alerts for previous fires or over-alert. Alert only when status changes from OK to WARNING/CRITICAL.
```

---

## Skill Reference Syntax

Agents reference skills with the pattern:

```
[skill: NAME]
```

Where NAME is one of:
- `agent-foundation` — Core worker rules, orchestration constraints, state management
- `function-call-hardening` — Provider-specific function call patterns and debugging

### How to Add New Skills

1. Create `packages/agents/src/skills/my-skill.ts` with a named export
2. Add to `BUILTIN_SKILLS` in `packages/agents/src/skills/index.ts`
3. Reference in persona via `[skill: my-skill]`
4. Runner automatically expands at fire time

---

## Token Savings Example

### Before (all rules inline in persona)

```
Persona text: ~2500 tokens
Each fire: full persona expanded = 2500 tokens
Weekly fires (168 hours) = 168 × 2500 = 420,000 tokens
```

### After (rules in cached skills)

```
Skill Foundation: ~800 tokens → cached
Thin persona: ~400 tokens
Skill Foundation (cached): 0 tokens (cache hit)
Thin persona: ~400 tokens
Weekly fires: first fire = 1200 tokens, next 167 fires = 167 × 400 = 66,800 tokens
Total: 1200 + 66,800 = 68,000 tokens (84% savings!)
```

---

## Backward Compatibility

Existing agents (without `[skill: …]` references) continue to work unchanged:
- Runner automatically prepends `[skill: Agent Foundation]` for compatibility
- No migration needed
- Operators can gradually move agents to explicit skill references

---

## Version & Cache Control

Each skill has a version (1.0, 2.0, etc.):
- **Version 1.0** is stable and cached
- If we update rules (e.g., new hard rules), we bump to **1.1** or **2.0**
- Operators can explicitly reference a version: `[skill: Agent Foundation v1.0]` (future)

For now, all skills are v1.0 and auto-cached on providers that support it (Claude, DeepSeek, OpenAI).

---

## Monitoring & Debugging

When an agent fires, the runner logs:
- Detected skill references (if any)
- Whether Agent Foundation was auto-prepended (legacy agents)
- Estimated cache hit rate (if provider supports it)

Example log:
```
[agents] agent_id=abc123 name="Daily Calendar Digest" 
  skills=["agent-foundation","function-call-hardening"]
  provider="claude" cache_enabled=true
  persona_tokens=450 cached_foundation_tokens=~800
```

---

## Future Enhancements

1. **Operator-owned skills:** Allow operators to define custom skills in their deploy config
2. **Cache tag standardization:** Define how each provider marks cached sections
3. **Skill versioning:** `[skill: Agent Foundation v1.1]` with fallback to v1.0
4. **Performance dashboard:** Track cache hit rates, token savings per agent per week
5. **Skill composition:** Agents reference multiple skills that get merged (e.g., `[skills: foundation, hardening, custom]`)
