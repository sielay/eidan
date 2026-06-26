# Implementation Summary: ask_user confirm fallback

## Overview

Fixed ask_user tool with type='confirm' to work gracefully in non-interactive contexts (background agents, procedures, scheduled jobs) by escalating decisions to the operator's inbox instead of throwing errors.

## Changes Made

### 1. New Plugin: `@eidandev/ask-user-fallback`

**Location**: `packages/ask-user-fallback/`

**Files**:
- `src/index.ts` — Main plugin implementation
  - Hooks into 'toolcall' phase with priority 30
  - Detects non-interactive context via IS_SUB_AGENT env var
  - Intercepts ask_user calls with type='confirm'
  - Escalates decision via escalations service
  - Returns stub response: `{ decision: 'PENDING_HUMAN_REVIEW', escalation_id: '...' }`
  
- `src/index.test.ts` — Plugin structure and setup tests
  - Validates plugin exports and manifest
  - Tests hook registration
  
- `src/hook.test.ts` — Hook logic tests
  - Tests interception logic in both contexts
  - Validates response format
  - Tests edge cases (non-confirm types, non-ask_user tools)

- `package.json` — Dependencies and exports
- `tsconfig.json` — TypeScript configuration
- `README.md` — Usage documentation and testing guide

### 2. Plugin Registration

**File**: `infra/fly-mb/matbot.yaml`

- Added `./packages/ask-user-fallback` to plugin list
- Positioned after `./packages/escalations` (dependency)
- Positioned before `./external/matbot/packages/plugins/ask-user` (interception point)

### 3. Documentation Updates

**File**: `docs/plugins/ask-user.md`

- Added "Non-interactive contexts" section
- Documented special response format for escalated decisions
- Provided code example for handling both interactive and non-interactive paths
- Added note about using confirm gates in autonomous workflows

### 4. Issue Documentation

**File**: `ISSUE_CONFIRM_FIX.md`

- GitHub issue template
- Detailed problem statement and solution
- Acceptance criteria verification
- Usage examples (before/after)
- Testing instructions
- Migration guide for existing code

## How It Works

### Interactive Context (Normal Flow)
```
user → ask_user(type='confirm') → [TTY available]
       → Frontend renders dialog
       → User confirms/denies
       → Returns { name, answer }
```

### Non-Interactive Context (Escalation Flow)
```
background_agent → ask_user(type='confirm') → [IS_SUB_AGENT set]
                   → ask-user-fallback hook intercepts
                   → Escalates to inbox
                   → Returns { decision: 'PENDING_HUMAN_REVIEW', escalation_id: '...' }
                   → Agent continues
                   → Operator reviews escalations inbox
                   → Approves/denies decision
```

## Acceptance Criteria Met

✅ **ask_user type='confirm' no longer throws in background context**
- Hook intercepts and returns stub response
- Agent doesn't fail

✅ **Decision is logged to escalations inbox with suggested_action and required fields**
- Calls `escalations.raise()` with:
  - severity: 'medium'
  - reasonClass: 'missing_input'
  - suggestedAction: 'Approve or deny: {label}'
  - metadata: { tool, type, name, label }
  - userId, conversationId

✅ **Agent receives { decision: 'PENDING_HUMAN_REVIEW', escalation_id: '...' }**
- Response format matches specification
- Includes actual escalation ID from database

✅ **Tests cover: interactive context (normal flow), non-interactive context (escalation flow)**
- index.test.ts: Plugin structure and hook registration
- hook.test.ts: Logic for both contexts

## Technical Details

### Non-Interactive Detection

Uses `process.env['IS_SUB_AGENT']` which is set by:
- matbot `background` plugin for background jobs
- eidan job runners for scheduled routines
- eidan procedure runner for isolated VM execution

### Escalation Integration

- Uses existing `@eidandev/escalations` service
- Logs to `eidan.escalations` table
- Deduping prevents duplicate escalations per agent
- Notification delivery via Telegram (primary) + Slack (optional)

### Hook Priority

Set to 30 to run high-priority before most other hooks, ensuring interception happens early in the toolcall phase.

## Migration Path

Existing agent code calling `ask_user` with type='confirm' should add handling for the new response format:

```typescript
const result = await ask_user({ 
  type: 'confirm',
  name: 'deploy',
  label: 'Deploy to production?'
});

if (result.decision === 'PENDING_HUMAN_REVIEW') {
  // Escalated to inbox; operator will review and approve/deny
  // Agent can exit gracefully or retry later
  console.log(`Decision escalated: ${result.escalation_id}`);
} else {
  // Normal interactive flow
  const { answer } = result;
  if (answer) { /* proceed */ } else { /* abort */ }
}
```

## Files Summary

| File | Purpose | Status |
|------|---------|--------|
| packages/ask-user-fallback/src/index.ts | Plugin implementation | ✅ Created |
| packages/ask-user-fallback/src/index.test.ts | Basic tests | ✅ Created |
| packages/ask-user-fallback/src/hook.test.ts | Logic tests | ✅ Created |
| packages/ask-user-fallback/package.json | Package config | ✅ Created |
| packages/ask-user-fallback/tsconfig.json | TS config | ✅ Created |
| packages/ask-user-fallback/README.md | Usage docs | ✅ Created |
| infra/fly-mb/matbot.yaml | Plugin registration | ✅ Updated |
| docs/plugins/ask-user.md | Tool documentation | ✅ Updated |
| ISSUE_CONFIRM_FIX.md | Issue template | ✅ Created |
| IMPLEMENTATION_SUMMARY.md | This file | ✅ Created |

## Testing

Run tests:
```bash
npm test
```

Manual test:
```bash
# Start background agent with confirm gate
eidan background({ prompt: "Approve task?", type: "confirm" })
# Returns: { decision: 'PENDING_HUMAN_REVIEW', escalation_id: '...' }

# Check escalations inbox
# Operator approves/denies decision

# Agent continues based on escalation outcome
```

## Next Steps

1. Code review of implementation
2. Typecheck and lint verification
3. Integration testing in deployed environment
4. Operator training on escalations inbox workflow
5. Monitor for any edge cases in production
