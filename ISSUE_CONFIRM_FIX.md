# Fix: ask_user confirm type fails in non-interactive contexts

## Issue

The `ask_user` tool with `type='confirm'` throws an error when called in non-interactive contexts (background agents, procedures, scheduled jobs). This breaks decision gates in autonomous workflows.

**Example failure**:
```
eidan background({ prompt: "Run migration now?", type: "confirm" })
→ Error: ask_user requires interactive terminal (no TTY)
```

## Root Cause

The `ask_user` matbot engine plugin expects a frontend to render interactive prompts. In background/non-interactive contexts where `IS_SUB_AGENT` is set, there's no TTY, so the tool fails rather than gracefully handling the missing interaction.

Decision points (confirm gates) in autonomous workflows need human input, but the absence of an interactive terminal shouldn't break the workflow — it should escalate to the operator's inbox instead.

## Solution

Implemented `@eidandev/ask-user-fallback` plugin that:

1. **Intercepts** `ask_user` calls with `type='confirm'` in non-interactive contexts
2. **Escalates** the decision to the operator's inbox via the escalations system
3. **Returns** a stub response `{ decision: 'PENDING_HUMAN_REVIEW', escalation_id: '...' }`
4. **Allows** the agent to continue instead of failing

The operator can then review and approve/deny the decision through the escalations inbox.

## Implementation

- **Plugin**: `packages/ask-user-fallback/`
- **Hook**: `toolcall` hook with priority 30 (runs before ask_user tool execution)
- **Detection**: `IS_SUB_AGENT` env var for non-interactive context
- **Escalation**: Uses `@eidandev/escalations` service to log decision
- **Tests**: Unit tests + integration test coverage for both paths

## Acceptance Criteria

✅ ask_user type='confirm' no longer throws in background context
✅ Decision is logged to escalations inbox with suggested_action and required fields
✅ Agent receives `{ decision: 'PENDING_HUMAN_REVIEW', escalation_id: '...' }`
✅ Tests cover: interactive context (normal flow), non-interactive context (escalation flow)

## Example Usage

### Before (fails)
```typescript
// In background agent
const { answer } = await ask_user({
  name: 'deploy',
  label: 'Deploy to production?',
  type: 'confirm'
});
// → Error: ask_user requires TTY
```

### After (succeeds, escalates)
```typescript
// In background agent
const result = await ask_user({
  name: 'deploy',
  label: 'Deploy to production?',
  type: 'confirm'
});
// result = { decision: 'PENDING_HUMAN_REVIEW', escalation_id: 'abc-123' }
// 
// Agent can check: if (result.decision === 'PENDING_HUMAN_REVIEW') { ... }
// Operator reviews escalations inbox to approve/deny
```

## Testing

Run tests:
```bash
npm test
```

Manual test:
```bash
# Start a background job that asks for confirmation
eidan background({ prompt: "Run maintenance task?", type: "confirm" })

# Check escalations inbox (should show pending decision)
# Review the escalation and approve/deny

# Agent continues based on escalation outcome
```

## Migration

Existing agent code calling `ask_user` with `type='confirm'` should check for the new response format:

```typescript
const result = await ask_user({ type: 'confirm', ... });

if (result.decision === 'PENDING_HUMAN_REVIEW') {
  // Handle pending decision (escalation created)
  // Agent can retry later or exit gracefully
} else {
  // Normal interactive path: result = { name, answer }
  const { answer } = result;
  // ... proceed with answer
}
```

## Related

- `@eidandev/escalations` — decision logging system
- `@eidandev/notify` — notification delivery
- matbot `ask_user` plugin — the tool being wrapped
- matbot `background` plugin — creates non-interactive contexts
