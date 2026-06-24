// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { DomainsDb } from './db.js';
import { buildDomainsTools } from './tools.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Charles domains inventory: manual entry and registrar API import (GoDaddy + Cyberfolks) ' +
      'with web screen and venture-resource picker integration.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/charles-domains');
    const db = new DomainsDb(url);
    await db.ensureSchema();
    for (const tool of buildDomainsTools(db)) services.tools.register(tool);
    console.log('[charles-domains] registered domains tools');
  },
};
