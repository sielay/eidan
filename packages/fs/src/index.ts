// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { FsDb } from './db.js';
import { buildFsTools } from './tools.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Eidan virtual filesystem: file browser, folder organization, and local storage with pluggable cloud adapters.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/fs');
    const db = new FsDb(url);
    await db.ensureSchema();
    for (const tool of buildFsTools(db)) services.tools.register(tool);
    console.log('[fs] registered fs tools');
  },
};
