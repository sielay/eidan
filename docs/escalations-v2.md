# Escalations v2: Bidirectional Agent Messaging

Escalations v2 extends the one-way operator-facing inbox into a bidirectional messaging system where agents can escalate to other agents or to the operator, receive structured feedback, and act on responses.

## Overview

Escalations v2 supports five types of escalations:

- **agent_to_operator**: Traditional one-way escalation (default, backwards compatible)
- **agent_to_agent**: Agent raises an issue and names the agent that should resolve it
- **operator_to_agent**: Operator sends feedback/decision to an agent
- **operator_prompt**: Operator prompts an agent to take an action
- **decision_gate**: Decision point where an agent awaits operator input before proceeding

## Core Concepts

### Status Lifecycle

Old (v1): `pending` → `acknowledged` → `resolved`

New (v2):
- **agent_to_operator**: `pending` → `acknowledged` → `responded` → `resolved`
- **agent_to_agent**: `open` → `responded` → `resolved`
- **operator_to_agent**: `pending` → `responded` → `resolved`

### Response Structure

When an escalation is answered, the response contains:

```typescript
{
  feedback: string;              // The answer/decision
  reasoning?: string;            // Why this decision
  decision?: string;             // Machine-readable decision code
  tags?: string[];               // Labels for categorization
  next_agent?: string;           // Which agent handles next
}
```

## Usage Patterns

### Pattern 1: Agent-to-Agent Escalation

Agent A raises an issue, Agent B resolves it:

```typescript
// Agent A (Researcher)
await escalation_action({
  action: 'raise',
  escalation: {
    severity: 'high',
    reason_class: 'ambiguous_intent',
    suggested_action: 'Need clarity on data interpretation',
    from_agent: 'Researcher',
    to_agent: 'DataAnalyst',
    escalation_type: 'agent_to_agent',
    trigger_prompt: 'Review the ambiguous interpretation and clarify expected data shape',
  }
});

// Agent B (DataAnalyst) in next run queries for escalations addressed to them:
const escalations = await escalation_action({
  action: 'list',
  filter: {
    to_agent: 'DataAnalyst',
    status: 'open',
  }
});

// Agent B responds:
const esc = escalations[0];
await escalation_action({
  action: 'respond',
  id: esc.id,
  response: {
    feedback: 'Data shape is list<{id, value, timestamp}>. See schema docs.',
    decision: 'use_standard_schema',
    tags: ['documented', 'schema-v2'],
  }
});

// Agent A queries for responses in next run:
const responses = await escalation_action({
  action: 'list',
  filter: {
    from_agent: 'Researcher',
    status: 'responded',
  }
});
// Now reads response.feedback and continues
```

### Pattern 2: Operator Feedback to Agent

Operator makes a decision that enables agent to proceed:

```typescript
// Agent raises gate (operator_to_agent or decision_gate)
await escalation_action({
  action: 'raise',
  escalation: {
    severity: 'high',
    reason_class: 'permission_denied',
    suggested_action: 'Awaiting approval to call external API',
    from_agent: 'DataFetcher',
    escalation_type: 'decision_gate',
    trigger_prompt: 'Once operator approves, call the API and store results.',
  }
});

// [UI] Operator clicks "Respond" and enters approval
await respondEscalation(id, {
  feedback: 'Approved. Use credentials from vault/external_api_key.',
  decision: 'approved',
  reasoning: 'Risk review cleared; user has compliance clearance',
  tags: ['compliance-approved', 'prod-ready'],
  next_agent: 'DataFetcher',
});

// Agent's next turn queries for responses and finds decision='approved'
const responses = await escalation_action({
  action: 'list',
  filter: {
    to_agent: 'DataFetcher',  // or from_agent if self-awaiting
    status: 'responded',
  }
});
const approval = responses[0];
if (approval.response?.decision === 'approved') {
  // Proceed with API call
}
```

### Pattern 3: Legacy One-Way Escalation (Backwards Compatible)

Old tool still works; defaults to `agent_to_operator`:

```typescript
// Old tool (escalate)
await escalate({
  severity: 'medium',
  reason_class: 'over_budget',
  suggested_action: 'Need approval to exceed monthly limit by $100',
  evidence: ['current_spend: $9500', 'limit: $10000'],
});

// Stored with:
// escalation_type = 'agent_to_operator'
// status = 'pending' (v1 default)
// from_agent = null, to_agent = null

// Operator sees it in Inbox, clicks Acknowledge/Resolve as before
```

## API Reference

### escalate (v1 tool, still works)

```typescript
await escalate({
  severity: 'low' | 'medium' | 'high',
  reason_class: 'missing_input' | 'permission_denied' | ... | 'other',
  suggested_action: string,
  evidence?: unknown[],
});
```

Returns: `{ escalated: true, id: string } | { escalated: false, reason: string }`

### escalation_action (v2 tool, new)

#### raise

```typescript
await escalation_action({
  action: 'raise',
  escalation: {
    severity: 'low' | 'medium' | 'high',
    reason_class: string,
    suggested_action: string,
    from_agent?: string,
    to_agent?: string,
    escalation_type?: 'agent_to_operator' | 'agent_to_agent' | 'operator_to_agent' | 'operator_prompt' | 'decision_gate',
    trigger_prompt?: string,
    evidence?: unknown[],
  }
});
```

#### respond

```typescript
await escalation_action({
  action: 'respond',
  id: string,  // escalation ID
  response: {
    feedback: string,
    reasoning?: string,
    decision?: string,
    tags?: string[],
    next_agent?: string,
  }
});
```

#### list

```typescript
await escalation_action({
  action: 'list',
  filter: {
    from_agent?: string,
    to_agent?: string,
    status?: 'pending' | 'open' | 'acknowledged' | 'responded' | 'resolved' | 'rejected',
    limit?: number,  // default 100, max 500
  }
});
```

Returns: `{ escalations: EscalationRow[] }`

### Service API (TypeScript)

```typescript
// services.Escalations?.raise(args)
interface RaiseArgs {
  severity: Severity;
  reasonClass: string;
  suggestedAction?: string;
  evidence?: unknown[];
  agentId?: string;
  conversationId?: string;
  fromAgent?: string;
  toAgent?: string;
  escalationType?: EscalationType;
  triggerPrompt?: string;
  userId?: string;
}

// services.Escalations?.respond(args)
interface RespondArgs {
  id: string;
  feedback: string;
  reasoning?: string;
  decision?: string;
  tags?: string[];
  nextAgent?: string;
  userId?: string;
}

// services.Escalations?.list(args)
interface ListArgs {
  userId: string;
  fromAgent?: string;
  toAgent?: string;
  status?: EscalationStatus;
  limit?: number;
}
```

### Web UI API

#### GET /api/escalations

Lists escalations; returns all new fields:

```typescript
{
  escalations: [{
    id: string,
    status: string,
    severity: string,
    reason_class: string,
    from_agent: string | null,
    to_agent: string | null,
    escalation_type: string,
    response: { feedback?, reasoning?, decision?, tags?, next_agent? } | null,
    trigger_prompt: string | null,
    created_at: string,
    responded_at: string | null,
    resolved_at: string | null,
    ...
  }]
}
```

#### POST /api/escalations/[id]/respond

Send feedback from operator:

```typescript
{
  feedback: string,
  reasoning?: string,
  decision?: string,
  tags?: string[],
  next_agent?: string,
}
```

## Design Notes

### Status Transitions

- **pending** (v1 default for agent_to_operator): operator has not yet acted
- **open** (v2 default for agent_to_agent): awaiting agent response
- **acknowledged**: operator has seen the escalation (v1 intermediate state)
- **responded**: someone has answered with feedback/decision
- **resolved**: escalation is closed; issue handled
- **rejected**: escalation was invalid or retracted

### Deduplication

v1 deduplication still works: one pending escalation per agent (per agentId). V2 escalations don't dedupe by default — each raise creates a new row. To dedupe, check `list()` before raising.

### Backwards Compatibility

- Old `escalate()` tool still works; raises with `escalation_type = 'agent_to_operator'`, `status = 'pending'`
- Old acknowledge/resolve endpoints still work
- New respond endpoint doesn't conflict (separate action)
- Missing fields (from_agent, to_agent, etc.) default to null and don't break existing queries

### Audit Trail

All escalations track:
- `created_at`: when raised
- `responded_at`: when answered (if answered)
- `resolved_at`: when closed (if closed)
- `responded_by`: user ID of operator/agent who responded

## Testing

See `packages/escalations/src/escalations.test.ts` for patterns:
- Agent-to-agent escalation and response
- Operator-to-agent feedback
- Query patterns (list by to_agent, status, etc.)
- Backwards compatibility with v1
