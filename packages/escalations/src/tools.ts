// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, JSONSchema } from '@matatbread/matbot-plugin-api';
import type { EscalationsService, Severity } from './store.js';

const SEVERITY = ['low', 'medium', 'high'];
const REASONS = [
  'missing_input', 'permission_denied', 'external_failure', 'ambiguous_intent',
  'over_budget', 'over_capacity', 'no_progress', 'unrecoverable_error', 'other',
];

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: SEVERITY, description: 'How urgent: low / medium / high.' },
    reason_class: { type: 'string', enum: REASONS, description: 'Why you are escalating (the closest category).' },
    suggested_action: { type: 'string', description: 'One clear line telling the operator what to do.', minLength: 1 },
    evidence: { type: 'array', items: {}, description: 'Optional supporting items: urls, ids, short quotes.' },
  },
  required: ['severity', 'reason_class', 'suggested_action'],
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
      inputSchema: SCHEMA,
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
          });
          yield {
            type: 'result',
            value: res ? { escalated: true, id: res.id } : { escalated: false, reason: 'a pending escalation already exists' },
          };
        },
      },
    },
  ];
}
