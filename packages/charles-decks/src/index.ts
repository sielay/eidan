// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { buildDeckTools } from './tools.js';

// Decks plugin (charles#8) — registers the render_deck tool: agent-composed Marp markdown →
// editable pptx/html/pdf, stored via matbot's FileStore and surfaced as download chips. Stateless;
// the FileStore is resolved per-call from the tool context (ctx.files), so a degraded host without
// one simply gets a clean error at call time rather than blocking activation.
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Charles deck rendering: render_deck turns agent-composed Marp markdown into editable ' +
      'pptx/html/pdf files (via the marp CLI), stored through the host FileStore as download chips.',
  },
  async setup(services: MatbotServices) {
    for (const tool of buildDeckTools()) services.tools.register(tool);
    console.log('[decks] registered render_deck');
  },
};
