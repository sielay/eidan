// SPDX-License-Identifier: AGPL-3.0-or-later
// Content — media/campaign tools for the content workflow. Today: image_generate (OpenAI → artifacts).
// The intended home for the content-workflow engine (WorkflowDef configs + stage runner) as it lands.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

import { imageGenerateTool } from './image-tool.js';
import { ContentDb } from './db.js';
import { buildBrandTool } from './brand-tool.js';
import { buildWorkflowTool } from './workflow-tool.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Content media tools: image_generate (OpenAI gpt-image-1 → downloadable, card-linkable artifacts) ' +
      'and brand_kit (per-scope voice/style that grounds generation). Home for the content-workflow engine.',
  },
  async setup(services: MatbotServices) {
    services.tools.register(imageGenerateTool());

    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (url) {
      const db = new ContentDb(url);
      await db.ensureSchema();
      services.tools.register(buildBrandTool(db));
      services.tools.register(buildWorkflowTool(db));
      console.log('[content] registered image_generate + brand_kit + content_workflow');
    } else {
      console.log('[content] registered image_generate (brand_kit disabled: no EIDAN_DATABASE_URL)');
    }
  },
};
