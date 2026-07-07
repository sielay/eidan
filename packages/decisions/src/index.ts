// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { DecisionRecord, JobCursorRecord } from './types.js';
import { buildDecisionTools } from './tools.js';

// A first-class, searchable decision log (the 'decisions' KV namespace) plus durable per-job cursors
// (the 'job_cursor' namespace) — both over the matbot Store, queried with the reference engine.
// Deliberately NOT buried in the knowledge graph: decisions are their own retrievable surface, with
// [[knowledge-slug]] links as connective tissue. The doctrine: search before deciding, record after.
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'eidan decision log: a searchable, first-class record of decisions (decision_record / ' +
      'decision_search) plus durable per-job cursors (job_cursor) for recurring agents and jobs. ' +
      'Backed by the matbot Store (eidan.kv), so it survives restarts and is queryable by text, tag, ' +
      'and status. Agents consult it before re-deciding and record after settling a choice.',
  },
  async setup(services: MatbotServices) {
    const decisions = services.createStore<DecisionRecord>('decisions');
    const cursors   = services.createStore<JobCursorRecord>('job_cursor');
    for (const tool of buildDecisionTools(decisions, cursors)) services.tools.register(tool);
    console.log('[decisions] decision_record + decision_search + job_cursor tools registered');

    // Doctrine (always-on, one line): retrieve before deriving; record venture-linked after.
    services.hooks.register({
      on: 'screen',
      pluginName: 'decisions',
      handler() {
        return { ephemeral: [{ type: 'text', text:
          'Decision doctrine: for any venture/business question (targeting, ICP, positioning, pricing, strategy), ' +
          'FIRST decision_search (filter by `venture`) and conversation_search for what was already concluded — ' +
          'retrieve, do not re-derive. If a recorded decision already answers the question (e.g. the ICP / target ' +
          'audience), USE it to complete the task and deliver the concrete output — do NOT ask the operator to ' +
          're-state what is already on record. Only ask when the record is genuinely missing or contradictory. ' +
          'After settling a NEW choice, decision_record it with `venture` set so it resurfaces next time.',
        }] };
      },
    });

    // Proactive recall: when the user's message matches a recorded decision (its venture, tags, or title),
    // surface it so the model reuses the prior conclusion instead of scanning from scratch.
    if (process.env['EIDAN_DECISIONS_PROACTIVE_RECALL'] !== '0') {
      services.hooks.register({
        on: 'screen',
        pluginName: 'decisions',
        async handler(ctx) {
          const msgs = ctx.session.messages;
          const last = msgs[msgs.length - 1] as { role?: string; content?: unknown[] } | undefined;
          if (last?.role !== 'user') return;
          const text = (last.content ?? [])
            .filter((b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text')
            .map((b) => String((b as Record<string, unknown>)['text'] ?? ''))
            .join(' ')
            .toLowerCase();
          if (text.length < 8) return;

          const res = await decisions.query({
            where: { op: 'eq', field: 'status', value: 'accepted' },
            sort: [{ field: 'updatedAt', dir: 'desc' }],
            limit: 40,
          });
          const hits = res.items.filter((d) => {
            const hay = [d.venture ?? '', ...(d.tags ?? []), ...d.title.split(/\W+/)]
              .map((x) => x.toLowerCase()).filter((x) => x.length > 2);
            return hay.some((h) => text.includes(h));
          }).slice(0, 3);
          if (!hits.length) return;

          const brief = ['## Prior decisions on record — reuse these, do not re-derive:', '',
            ...hits.map((d) => `- **${d.title}**${d.venture ? ` [${d.venture}]` : ''}: ${d.decision}${d.rationale ? ` (why: ${d.rationale})` : ''}`),
          ].join('\n');
          return { ephemeral: [{ type: 'text', text: brief }] };
        },
      });
    }
  },
};
