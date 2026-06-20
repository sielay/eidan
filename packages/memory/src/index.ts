// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { EidanMemory } from './eidan-memory.js';
import { EidanKnowledgeIndex } from './knowledge-index.js';
import { rememberTool, recallTool } from './tools.js';

// Advertise EidanMemory on the service registry so other plugins (bundles) can consume the
// relational memory surface with full type safety: services.EidanMemory?.searchKnowledge(...).
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanMemory?: EidanMemory;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'eidan relational long-term memory (knowledge + notes over eidan.*, RLS-scoped): registers the EidanMemory service and the remember/recall tools.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/memory');
    const mem = new EidanMemory(new Db(url));
    await services.register('EidanMemory', mem);
    // Expose the SAME relational knowledge as matbot's KnowledgeIndex, so skills/cognition/rumsfeld
    // read+write eidan.knowledge (one unified store) rather than a separate matbot index.
    await services.register('KnowledgeIndex', new EidanKnowledgeIndex(mem));
    services.tools.register(rememberTool(mem));
    services.tools.register(recallTool(mem));
  },
};
