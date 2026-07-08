// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { CrmDb } from './db.js';
import { buildCrmTools } from './tools.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Charles CRM — venture-scoped deals pipeline (kanban by stage), contacts registry, ' +
      'and activity timeline (calls, emails, notes, meetings, stage changes).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/crm');
    const db = new CrmDb(url);
    await db.ensureSchema();
    for (const tool of buildCrmTools(db)) services.tools.register(tool);
    console.log('[crm] registered CRM tools (contacts, deals, activities)');
  },
};
