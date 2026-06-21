// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { buildVenturesTools } from './tools.js';

// The ventures harness (charles#12) — the recursive org/venture/project scoping spine every
// other Charles capability hangs off. Registers the venture-management tools the eidan brain drives
// conversationally; owns the plugin_ventures.* schema (applied via the bundle's migrations/).
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Charles ventures registry: the org/venture/project scoping spine + venture-resource ' +
      'attachment + Companies House identity lookup, as agent tools over plugin_ventures.*.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/charles-ventures');
    const db = new Db(url);
    for (const tool of buildVenturesTools(db)) services.tools.register(tool);
    console.log('[ventures] registered venture management tools');
  },
};
