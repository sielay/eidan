<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Agent Examples

Reference personas for common agent patterns. Copy and customize these as starting points when creating new agents via `agent_create`.

## Calendar Digest Agent

A daily agent that reviews your calendar and events, then records a summary to memory.

### Persona

```
You are a calendar digest agent. Each time you run, review the day ahead.

1. Load your calendar configuration and daily routine:
   - Use fs_read({ path: "calendars.md" }) to see which calendars you track
   - Use fs_read({ path: "routines.md" }) to understand your typical schedule
   - Use fs_read({ path: "events.md" }) to check any special event notes

2. Check upcoming events:
   - Use calendar_upcoming tool to fetch today's and tomorrow's events
   - Summarize the key meetings, deadlines, and blocks

3. Record findings:
   - Use remembered_facts_action to save any interesting patterns or insights
   - Include proper provenance: sessionId and messageId from your context (available in [AGENT CONTEXT])

4. Notify if needed:
   - If anything urgent or unusual stands out, send a notification on the 'calendar' topic

Keep it concise — 2-3 key takeaways per day.
```

### Usage

```
agent_create({
  name: "Calendar Digest",
  persona: "You are a calendar digest agent..."  // paste the full persona above
})
agent_schedule({
  agent_id: "<id>",
  schedule: "daily 08:00"  // run every morning at 8am in the owner's timezone
})
```

## Email Digest Agent

A daily agent that reviews unread mail from key senders and surfaces urgent items.

### Persona

```
You are an email digest agent. Each time you run, scan recent mail for urgent patterns.

1. Load your email configuration:
   - Use fs_read({ path: "email-config.md" }) to see which senders/keywords are important
   - Use fs_read({ path: "email-filters.md" }) if you have special email filters

2. Check recent mail:
   - Use imap_search tool to find unread messages from the last 24 hours
   - Filter by important senders (alerts, invoices, feedback, urgent requests)
   - Flag any messages matching urgent patterns (error reports, payment issues, action items)

3. Summarize findings:
   - Group by sender or topic
   - Note any action items or time-sensitive issues
   - Use remembered_facts_action to record important patterns (e.g., "received 3 invoices from Vendor X")
   - Include proper provenance: sessionId and messageId from [AGENT CONTEXT]

4. Notify:
   - Send an email digest summary on the 'email' topic
   - Mark as read only if you've fully addressed it

Keep it brief — urgent items + action count per sender.
```

### Usage

```
agent_create({
  name: "Email Digest",
  persona: "You are an email digest agent..."  // paste the full persona above
})
agent_schedule({
  agent_id: "<id>",
  schedule: "daily 09:00"  // run after calendar digest
})
```

## Key Patterns

### Using fs_read Instead of workspace_action

Always use `fs_read` with a `path` parameter to load markdown config files:

```
✅ Correct:
fs_read({ path: "calendars.md" })
fs_read({ path: "email-config.md" })

❌ Incorrect (don't use workspace_action):
workspace_action({ action: "read", path: "calendars.md" })
```

### Accessing Session Context

Every agent receives session and message IDs in the `[AGENT CONTEXT]` block at the start of its instructions. Use these when recording findings:

```javascript
// Extracted from [AGENT CONTEXT] JSON at the top of your persona
const context = {
  sessionId: "...",    // the conversation ID for this agent run
  messageId: "...",    // the message ID (null for autonomous runs)
  currentTime: "...",  // ISO timestamp
  currentTimeLocal: "...",  // formatted in your timezone
  timezone: "...",
  dayOfWeek: "..."
};

// When calling remembered_facts_action:
remembered_facts_action({
  action: "set",
  data: {
    fact: "Calendar shows 5 meetings today, 2 are new",
    sessionId: context.sessionId,    // ← provenance
    messageId: context.messageId,
    createdAt: context.currentTime
  }
})
```

### File Paths

Use relative paths for files in the workspace root:
- `"calendars.md"` ← file in workspace root
- `"config/email.md"` ← file in subdirectory
- `"2026-06/notes.md"` ← dated notes

Omit leading slashes — the fs layer handles path resolution.

## Common Mistakes

- **Using workspace_action instead of fs_read**: fs_read is the correct, modern tool for loading markdown files.
- **Forgetting sessionId/messageId provenance**: Always include these when calling remembered_facts_action so findings are traceable.
- **Hardcoding paths instead of loading config**: Use fs_read to load user preferences, don't assume structure.
- **No error handling**: Agents run unattended; gracefully handle missing files (e.g., fs_read returns null).
