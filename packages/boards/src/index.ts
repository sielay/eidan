// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

import { BoardsDb } from './db.js';
import { buildBoardsTools } from './tools.js';

// Boards — a bundle-agnostic kanban/planning substrate (plugin_boards). Boards optionally bind to a
// context (venture, charlotte, …) or stand alone; cards carry typed refs, status and an activity log.
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Boards: a reusable kanban/planning substrate (boards + rich cards with typed refs, status and an activity log), as agent tools over plugin_boards.*.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/boards');
    const db = new BoardsDb(url);
    await db.ensureSchema();
    for (const tool of buildBoardsTools(db)) services.tools.register(tool);
    console.log('[boards] registered board/card tools');
  },
};
