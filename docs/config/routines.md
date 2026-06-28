# routines.md

Agent task definitions and execution rules. Static sections enable prompt caching; dynamic sections refresh per run.

<!-- CACHE_STATIC_CATEGORIES_START -->
## 1. TASK CATEGORIES (Static - core task taxonomy)

| Category | Description | Priority | Tools | Frequency |
|----------|-------------|----------|-------|-----------|
| daily-standup | Morning team sync prep (blockers, wins, focus) | high | memory, notify | daily |
| weekly-review | End-of-week retrospective (done/learn/next) | high | memory, notes | weekly |
| inbox-triage | Process new messages + classify urgency | medium | memory, fs | daily |
| venture-sync | Check venture-specific metrics + updates | medium | fs, http | 2x weekly |
| deep-work | Uninterrupted focus blocks (off-calendar) | high | notify, memory | as-needed |
| escalation | Handle high-priority items + decisions | high | notify, delegate | as-needed |
| maintenance | Cleanup, archival, housekeeping | low | memory, fs | weekly |

<!-- CACHE_STATIC_CATEGORIES_END -->

<!-- CACHE_STATIC_EXECUTION_RULES_START -->
## 2. EXECUTION RULES (Static - how routines run)

### Concurrency
- Max 2 parallel routines; queue the rest
- Escalation routines get priority queue bypass
- Long-running routines (>10 min) run detached + notify on completion

### Failure handling
- Retry on transient errors (network, lock) up to 2x
- On persistent error, escalate to human + log to #ops
- Partial success is OK (e.g., 3/5 venture checks succeeded)

### Memory updates
- Always append to memory on routine completion (win/learn/decision)
- Never modify historical memory (delete_at = null is immutable)
- Use soft-delete (deleted_at) for reversible changes only

### Notifications
- Routine result (success/failure) → delivery topic = `routine:<category>`
- Escalations → `escalation` topic (Slack + push)
- Verbose logging to `#ops` for debugging (dev mode only)

<!-- CACHE_STATIC_EXECUTION_RULES_END -->

<!-- CACHE_STATIC_PROMPT_TEMPLATE_START -->
## 3. AGENT PROMPT TEMPLATE (Static - framing for LLM)

When executing a routine, prepend this framing to the routine's task:

```
You are executing a system routine: {ROUTINE_CATEGORY}.

Your responsibilities:
- Execute the task steps below precisely and completely
- If you need external data, fetch it fresh (don't rely on cached memory)
- Record all outcomes (success/failure) to memory before returning
- For escalations, create a clear summary with options for human decision

Operational constraints:
- Total wall-clock budget: {TIMEOUT_MINUTES} minutes
- Memory quota: append ≤ 500 chars per routine
- Notification budget: ≤ {MAX_NOTIFICATIONS} notifications per routine
```

<!-- CACHE_STATIC_PROMPT_TEMPLATE_END -->

## 4. ACTIVE ROUTINES (Dynamic - adjust task list daily)

These routines run on their configured schedule. Updated daily; never cached.

### daily-standup (6:00 AM)
**Task**: Prep morning standup for the team.
1. Fetch yesterday's memory notes (wins, blockers)
2. Check calendar for today's high-priority events (>= high effort)
3. Scan #inbox for new messages requiring response
4. Compose standup summary: [Wins] [Blockers] [Today's focus]
5. Post summary to #standup; archive yesterday's thread
**Timeout**: 5 minutes
**Escalate if**: Unresolved blockers from yesterday OR more than 3 new high-priority inbox items

### weekly-review (Friday 5:00 PM)
**Task**: End-of-week reflection and planning.
1. Query memory: this week's accomplishments + learnings
2. Count completed tasks by category (use venture routing)
3. Tally effort spent (high/medium/low) vs. planned
4. Review next week's calendar (look 7 days ahead)
5. Draft "week in review" note + "next week's forecast"
6. Store in memory; notify #planning with summary
**Timeout**: 10 minutes
**Escalate if**: Significant effort variance (>20% vs. plan) OR critical task slipped

### venture-sync (Mon/Wed 9:00 AM)
**Task**: Update venture tracking from external sources.
1. For each venture in calendars.md §5:
   - Check last update time (memory)
   - If > 48h stale, refresh metrics
   - Log changes to venture's Slack channel
2. Aggregate venture health summary
3. Update memory with venture snapshot
**Timeout**: 8 minutes
**Escalate if**: Any venture status is "at-risk" OR new dependency flagged

### inbox-triage (Daily 8:00 AM + 2:00 PM)
**Task**: Process new messages, classify urgency.
1. Scan recent messages from memory + Slack
2. Flag urgent (needs response today) vs. informational
3. Link urgent items to ventures (use calendars.md routing)
4. Route to agent responsible for that venture
5. Log summary to memory
**Timeout**: 5 minutes
**Escalate if**: >5 urgent items OR critical security/compliance flag

---

**Last updated**: 2024-06-28 by operator
**Cache invalidation**: Update when task categories or execution rules change; routine-specific tasks always fetch fresh
