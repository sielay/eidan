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
  },
};
