// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, JSONSchema } from '@matatbread/matbot-plugin-api';
import type { EscalationsService, Severity, EscalationType, EscalationStatus } from './store.js';

const SEVERITY = ['low', 'medium', 'high'];
const REASONS = [
  'missing_input', 'permission_denied', 'external_failure', 'ambiguous_intent',
  'over_budget', 'over_capacity', 'no_progress', 'unrecoverable_error', 'other',
];
const ESCALATION_TYPES = ['agent_to_operator', 'agent_to_agent', 'operator_to_agent', 'operator_prompt', 'decision_gate'];

const RAISE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: SEVERITY, description: 'How urgent: low / medium / high.' },
    reason_class: { type: 'string', enum: REASONS, description: 'Why you are escalating (the closest category).' },
    suggested_action: { type: 'string', description: 'One clear line telling the operator what to do.', minLength: 1 },
    evidence: { type: 'array', items: {}, description: 'Optional supporting items: urls, ids, short quotes.' },
    from_agent: { type: 'string', description: 'Name of the agent raising this escalation.' },
    to_agent: { type: 'string', description: 'Name of the agent that should consume the response (for agent_to_agent escalations).' },
    escalation_type: { type: 'string', enum: ESCALATION_TYPES, description: 'Type of escalation.' },
    trigger_prompt: { type: 'string', description: 'How the next agent should act on this escalation.' },
  },
  required: ['severity', 'reason_class', 'suggested_action'],
  additionalProperties: false,
};

const ACTION_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['raise', 'respond', 'list'], description: 'What to do.' },
    id: { type: 'string', description: 'Escalation ID (required for respond, optional for others).' },
    escalation: { type: 'object', description: 'Escalation data (required for raise).' },
    response: { type: 'object', description: 'Response data (required for respond).' },
    filter: { type: 'object', description: 'Filters for list action.' },
  },
  required: ['action'],
  additionalProperties: false,
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function buildEscalateTools(svc: EscalationsService): Tool[] {
  return [
    {
      name: 'escalate',
      description:
        'Flag something that needs the human operator — it lands in their escalations Inbox and pings ' +
        'them. Use when you are blocked, need a decision or permission, hit a budget/capacity limit, or ' +
        'cannot recover on your own. Give a clear one-line suggested_action so they know what to do.',
      inputSchema: RAISE_SCHEMA,
      executor: {
        async *execute(input) {
          const a = (input ?? {}) as Record<string, unknown>;
          const suggested = str(a['suggested_action']).trim();
          if (!suggested) return yield { type: 'error', message: 'suggested_action is required' };
          const res = await svc.raise({
            severity: (str(a['severity']) || 'medium') as Severity,
            reasonClass: str(a['reason_class']) || 'other',
            suggestedAction: suggested,
            evidence: Array.isArray(a['evidence']) ? (a['evidence'] as unknown[]) : [],
            fromAgent: a['from_agent'] ? str(a['from_agent']) : undefined,
            toAgent: a['to_agent'] ? str(a['to_agent']) : undefined,
            escalationType: a['escalation_type'] ? (str(a['escalation_type']) as EscalationType) : undefined,
            triggerPrompt: a['trigger_prompt'] ? str(a['trigger_prompt']) : undefined,
          });
          yield {
            type: 'result',
            value: res ? { escalated: true, id: res.id } : { escalated: false, reason: 'a pending escalation already exists' },
          };
        },
      },
    },
    {
      name: 'escalation_action',
      description:
        'Bidirectional escalation operations: raise, respond to, or query escalations. ' +
        'Agents can query escalations addressed to them and read responses.',
      inputSchema: ACTION_SCHEMA,
      executor: {
        async *execute(input) {
          const a = (input ?? {}) as Record<string, unknown>;
          const action = str(a['action']).toLowerCase().trim();

          if (action === 'raise') {
            const esc = (a['escalation'] ?? {}) as Record<string, unknown>;
            const suggested = str(esc['suggested_action']).trim();
            if (!suggested) return yield { type: 'error', message: 'escalation.suggested_action is required' };
            const res = await svc.raise({
              severity: (str(esc['severity']) || 'medium') as Severity,
              reasonClass: str(esc['reason_class']) || 'other',
              suggestedAction: suggested,
              evidence: Array.isArray(esc['evidence']) ? (esc['evidence'] as unknown[]) : [],
              fromAgent: esc['from_agent'] ? str(esc['from_agent']) : undefined,
              toAgent: esc['to_agent'] ? str(esc['to_agent']) : undefined,
              escalationType: esc['escalation_type'] ? (str(esc['escalation_type']) as EscalationType) : undefined,
              triggerPrompt: esc['trigger_prompt'] ? str(esc['trigger_prompt']) : undefined,
            });
            yield {
              type: 'result',
              value: res ? { escalated: true, id: res.id } : { escalated: false, reason: 'a pending escalation already exists' },
            };
          } else if (action === 'respond') {
            const id = str(a['id']).trim();
            if (!id) return yield { type: 'error', message: 'id is required for respond action' };
            const resp = (a['response'] ?? {}) as Record<string, unknown>;
            const feedback = str(resp['feedback']).trim();
            if (!feedback) return yield { type: 'error', message: 'response.feedback is required' };
            const res = await svc.respond({
              id,
              feedback,
              reasoning: resp['reasoning'] ? str(resp['reasoning']) : undefined,
              decision: resp['decision'] ? str(resp['decision']) : undefined,
              tags: Array.isArray(resp['tags']) ? (resp['tags'] as string[]) : undefined,
              nextAgent: resp['next_agent'] ? str(resp['next_agent']) : undefined,
            });
            yield {
              type: 'result',
              value: res ? { responded: true, id: res.id } : { responded: false, reason: 'escalation not found or not in respondable state' },
            };
          } else if (action === 'list') {
            const filter = (a['filter'] ?? {}) as Record<string, unknown>;
            const rows = await svc.list({
              fromAgent: filter['from_agent'] ? str(filter['from_agent']) : undefined,
              toAgent: filter['to_agent'] ? str(filter['to_agent']) : undefined,
              status: filter['status'] ? (str(filter['status']) as EscalationStatus) : undefined,
              limit: filter['limit'] ? Number(filter['limit']) : undefined,
            });
            yield {
              type: 'result',
              value: {
                escalations: rows.map((r) => ({
                  id: r.id,
                  from_agent: r.from_agent,
                  to_agent: r.to_agent,
                  escalation_type: r.escalation_type,
                  status: r.status,
                  severity: r.severity,
                  reason_class: r.reason_class,
                  suggested_action: r.suggested_action,
                  response: r.response,
                  trigger_prompt: r.trigger_prompt,
                  created_at: r.created_at,
                  responded_at: r.responded_at,
                })),
              },
            };
          } else {
            yield { type: 'error', message: `unknown action: ${action}` };
          }
        },
      },
    },
  ];
}
