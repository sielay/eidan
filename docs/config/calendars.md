# calendars.md

Agent routing configuration for calendar events. Split into static (cache-eligible) and dynamic (always-fresh) sections for optimal LLM token efficiency.

<!-- CACHE_STATIC_ROUTING_START -->
## 1. CATEGORISE (Routing rules - static, rarely change)

Events are categorized by calendar name and keyword matching. This routing table is immutable per deployment.

| IF calendar / keyword matches | THEN category | Effort | Priority |
|------|---------|--------|----------|
| Calendar = "Work" | work | medium | high |
| Calendar = "Personal" | personal | low | medium |
| Calendar = "Health" OR keyword contains "doctor\|dentist\|therapy" | health | low | high |
| Calendar = "Finance" OR keyword contains "invoice\|payment\|bill" | finance | medium | high |
| Keyword contains "standup\|meeting\|sync" | sync | low | medium |
| Keyword contains "deadline\|launch\|release" | deadline | high | high |
| Keyword contains "vacation\|off\|holiday" | time-off | - | high |
| Keyword contains "focus\|deep work\|batch" | focus | medium | low |

### Routing logic
1. Check calendar name first (highest priority)
2. If calendar not in routing table, scan keywords (case-insensitive)
3. If no match, default to "general"
4. Effort + Priority determine escalation thresholds (high effort + high priority = early notice)

<!-- CACHE_STATIC_ROUTING_END -->

<!-- CACHE_STATIC_EFFORT_MODELS_START -->
## 2. EFFORT MODELS (Static effort estimates)

Predefined effort profiles for quick classification (no keyword parsing needed).

```
low: ≤ 30 min solo task (no coordination)
medium: 30 min – 3 hours (some coordination or prep)
high: > 3 hours OR multi-person coordination OR external dependency
```

For meetings:
- **sync**: 30 min group standup = low; 1h 1:1 = low; 2h workshop = medium
- **deadline**: review meeting = medium; final review = high
- **focus**: block = high (must protect)

<!-- CACHE_STATIC_EFFORT_MODELS_END -->

<!-- CACHE_STATIC_ESCALATION_START -->
## 3. ESCALATION RULES (Static, cache-friendly)

| Effort | Priority | Action | Window |
|--------|----------|--------|--------|
| high | high | Notify 2 days before + daily reminder | 48h before |
| high | medium | Notify 1 day before + reminder morning-of | 24h before |
| medium | high | Notify 1 day before | 24h before |
| medium | medium | Notify morning-of | 8h before |
| low | any | No proactive notice | - |

<!-- CACHE_STATIC_ESCALATION_END -->

## 5. VENTURE ROUTING (Dynamic - keywords may be updated at any time)

Ventures with board IDs for calendar analysis. Updated frequently; never cached.

| Keyword(s) | Venture | Board ID | Slack |
|---------|---------|----------|-------|
| eidan, matbot | eidan | b5c77609-e7f5-43db-a17f-8eac8b0e4e2a | #engineering-eidan |
| charles, venture capital | charles | a1b2c3d4-e5f6-47d8-a19b-2c3d4e5f6g7h | #ventures |
| content, writing | content | c9d0e1f2-a3b4-c5d6-e7f8-9a0b1c2d3e4f | #content |
| eidan-web, frontend | eidan-web | d7e8f9a0-b1c2-d3e4-f5a6-b7c8d9e0f1a2 | #frontend |

### Venture selection logic
1. Scan event keywords (title + description) for venture matches
2. Match against keywords (case-insensitive)
3. Return first matching venture; if no match, escalate to human (log to #inbox)
4. Link event to venture's Slack thread for context

## 6. DAILY WORKFLOW (Dynamic - adjust per day)

Current week's focus areas (updated Monday AM):

- **2024-W26 focus**: Charles fundraising push, eidan milestone release
- **Next 2 events to prep**: Charles board call (Thu 2pm), eidan 1:1 with team (Wed 10am)
- **Blocked time this week**: Fri 3-5pm (deep focus), Mon 9-11am (no meetings)

---

**Last updated**: 2024-06-28 by operator
**Cache invalidation**: If venture keywords or routing table changes, drop cache for this file
