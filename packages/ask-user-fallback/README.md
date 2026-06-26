# ask-user-fallback

Graceful fallback for `ask_user` tool in non-interactive contexts.

## Problem

When the `ask_user` tool (matbot engine plugin) is called in non-interactive contexts (background agents, procedures, scheduled jobs), it throws an error because there's no frontend to display the interactive prompt.

This breaks decision gates in autonomous workflows.

## Solution

This plugin intercepts `ask_user` calls with `type='confirm'` in non-interactive contexts and:

1. **Logs the decision to the escalations inbox** with full context (label, options, etc.)
2. **Returns a stub response** `{ decision: 'PENDING_HUMAN_REVIEW', escalation_id: '...' }` so the agent can continue
3. **Notifies the operator** via the escalations topic (Telegram + Slack)

The decision point is logged as a pending escalation, allowing the operator to approve/deny when they review the inbox.

## How it works

The plugin registers a high-priority `toolresult` hook that:

- Detects when `ask_user` with `type='confirm'` fails with an error
- Checks if we're in a non-interactive context (via `IS_SUB_AGENT` env var)
- If both true: escalates the decision to the inbox, returns a stub response
- If not: lets the error propagate (interactive path, or non-confirm types)

## Non-interactive context detection

Non-interactive contexts set `IS_SUB_AGENT=1`:
- Background agent runs (via `background` tool)
- Scheduled jobs / routines
- Procedures running in isolated VMs

## Testing

The plugin is tested to ensure:

1. **Interactive context (normal flow)**: ask_user with type='confirm' calls proceed normally, not intercepted
2. **Non-interactive context (escalation flow)**: ask_user with type='confirm' is intercepted, escalated, and returns stub response
3. **Other types**: ask_user with type != 'confirm' (text, select, etc.) proceed normally in all contexts

Manual testing:
```
# Start a background agent that asks for confirmation
eidan background({ prompt: "Approve deployment?", type: "confirm" })

# In non-interactive context, returns:
# { decision: 'PENDING_HUMAN_REVIEW', escalation_id: 'abc123-...' }

# Review escalations inbox to approve/deny the decision
```

## Dependencies

- `@eidandev/escalations` — logs decision to `eidan.escalations` table
- matbot `ask_user` plugin (loaded after)

## Response format

When intercepted:
```json
{
  "decision": "PENDING_HUMAN_REVIEW",
  "escalation_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Confirm: decision escalated to inbox (non-interactive context)"
}
```

Normal ask_user response (interactive):
```json
{
  "name": "confirm_action",
  "answer": true
}
```

Agent code should check for `decision === 'PENDING_HUMAN_REVIEW'` to handle the pending case.
