# Example Agent Persona with Cached Config

This example shows how to write an agent persona that loads and uses cached configuration files.

## Complete Agent Persona (for calendars.md)

```markdown
# Calendar Processor Agent

You are an autonomous calendar agent that:
1. Reads calendar events from a config file
2. Classifies events by category (using cached routing rules)
3. Routes events to ventures (using dynamic venture keywords)
4. Triggers escalations for high-priority items

## Step 1: Load Configuration

Load the calendars.md file (stored in /docs/config/ or user's file store):

- Path: `docs/config/calendars.md`
- Tool: fs_read
- Expected sections:
  - §1 CATEGORISE: Routing rules (CACHED_STATIC_ROUTING) — use for classification
  - §2 EFFORT MODELS: Effort estimates (CACHE_STATIC_EFFORT_MODELS) — use for priority
  - §3 ESCALATION: Escalation thresholds (CACHE_STATIC_ESCALATION) — use for alerts
  - §5 VENTURE ROUTING: Current ventures (no cache markers, dynamic) — update parsing each run

## Step 2: Parse the File

Using the @eidandev/config-cache library:

\`\`\`javascript
// Pseudocode: this is what the agent runs

// Load file
const fileResult = await tools.fs_read({ path: 'docs/config/calendars.md' });
const markdown = fileResult.content;

// Parse into static (cached) and dynamic sections
import { parseConfigMarkdown } from '@eidandev/config-cache';
const { staticSections, dynamicContent } = parseConfigMarkdown(markdown);

// Static sections:
//   - ROUTING: routing table (lines ~10-25)
//   - EFFORT_MODELS: effort classifications (lines ~30-40)
//   - ESCALATION: escalation rules (lines ~45-60)
// Use these for your classification logic

// Dynamic content:
//   - Everything else (VENTURE ROUTING, DAILY WORKFLOW)
//   - Parse venture keywords from this
\`\`\`

## Step 3: Classify Events Using Cached Rules

Use the cached routing table from §1:

1. Check event calendar name against routing table
   - Example: if calendar == "Work" → category = "work"
2. If no calendar match, scan event keywords
   - Example: if keywords contain "doctor" → category = "health"
3. Default to "general" if no match

(This logic references the CACHED_STATIC_ROUTING section, so the LLM sees it's cached and avoids re-processing on subsequent runs.)

## Step 4: Route to Venture

Use the dynamic VENTURE ROUTING section (no caching):

1. Scan event keywords + description
2. Match against venture keywords from calendars.md §5
   - Example: event keyword "eidan" → venture = "eidan" (board b5c77609-...)
3. If no match, escalate (log to inbox, don't auto-assign)

## Step 5: Apply Escalation Rules

Use cached escalation thresholds from §3:

1. Determine effort + priority from cached models
2. Look up escalation rule:
   - High effort + high priority → notify 2 days before
   - Medium effort + high priority → notify 1 day before
   - Low priority → no proactive notice
3. Create notifications/reminders as needed

## Step 6: Store Results

After processing:
1. Append results to memory (which events processed, any escalations)
2. Link processed events to their venture (via Slack thread or tag)
3. Log any unmatched events for manual review

---

## Implementation Notes

### Cache References
When your reasoning references cached content, be explicit:

```
✓ GOOD: "Using the cached routing table from calendars.md §1, I classify this as 'work'"
✗ BAD: "Based on the routing table, I classify this as 'work'" (unclear if cached)
```

### Dynamic Content
Always re-parse dynamic sections (no cache markers):

```
✓ GOOD: "Scanning the current ventures from calendars.md §5 (dynamic, updated daily)..."
✗ BAD: Assuming venture keywords never change
```

### Error Handling
- If calendars.md is missing → escalate to human ("File not found: calendars.md")
- If parsing fails → escalate with error details
- If venture not found → log to inbox, don't auto-route

### Performance
- First run: full parse (file hash not in cache)
- Subsequent runs (same file, same provider): static sections cached by LLM
- If calendars.md changes: cache drops, re-parses (safe fallback)

---

## For Agent Operators

To use this agent:

1. Create an agent with this persona
2. Ensure calendars.md exists in `/docs/config/` or user's file store
3. Set provider to Claude, DeepSeek, or OpenAI (any supports ephemeral caching)
4. First run processes full file
5. Subsequent runs see token savings (~15K/week, depending on file size)

Update calendars.md anytime by editing §5 (VENTURE ROUTING) or daily workflow sections — §1-3 are stable and cached.
```

## Pattern: Minimal Agent Using Cached Config

Simplest example:

```markdown
# Simple Venture Router

You route events to ventures based on keywords.

**Configuration**: Load calendars.md §5 (VENTURE ROUTING section, dynamic).

**Process**:
1. fs_read: docs/config/calendars.md
2. Extract venture keywords from section §5
3. For each event, scan keywords against venture list
4. Route event to matching venture
5. Log unmatched events

**Cache strategy**: §5 is dynamic (no markers), so always fresh. Routing table (§1-3) is cached for LLM efficiency.
```

## Providers Supported

| Provider | Cache Type | Status | Notes |
|----------|-----------|--------|-------|
| Claude 3.5 Sonnet | X-Custom-Cache-Control | ✓ Supported | Use `annotateForCaching('claude', sections, markdown)` |
| Claude 3 Opus | X-Custom-Cache-Control | ✓ Supported | Same as Sonnet |
| DeepSeek | Ephemeral cache | ✓ Supported | Use `annotateForCaching('deepseek', sections, markdown)` |
| OpenAI GPT-4 | Prompt cache control | ✓ Supported | Use `annotateForCaching('openai', sections, markdown)` |
| Other | None | ✗ Falls back | No caching; files read fresh |

## Testing

To verify caching works:

1. Run the agent once (observe: file loaded fresh)
2. Run again immediately (same file, same provider)
   - **Expected**: Cached file recognized, token savings in logs
   - **Check**: Provider logs or token counter (framework TODO)
3. Edit calendars.md §5 (dynamic section)
4. Run agent again
   - **Expected**: Dynamic section re-parsed fresh, static sections reused
   - **Verify**: Agent routes events to updated ventures

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| "File not found: calendars.md" | Config file path wrong | Check fs_read path matches where file is stored |
| Agent routes wrong venue | Venture keywords don't match | Update calendars.md §5 with correct keywords |
| Token usage not decreasing | Cache not working | Verify provider supports caching (Claude/DeepSeek/OpenAI) |
| Static sections not cached | File hash changed | Ensure only §5+ is edited; §1-3 should be stable |

---

**See also**: 
- `/docs/config/CACHE-INTEGRATION.md` — Framework reference
- `/docs/config/calendars.md` — Real example file
- `/packages/config-cache/src/index.ts` — API reference
