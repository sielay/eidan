// SPDX-License-Identifier: AGPL-3.0-or-later
// Content — media/campaign tools for the content workflow. Today: image_generate (OpenAI → artifacts).
// The intended home for the content-workflow engine (WorkflowDef configs + stage runner) as it lands.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

import { imageGenerateTool } from './image-tool.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Content media tools: image_generate (OpenAI gpt-image-1 → downloadable, card-linkable artifacts). ' +
      'Home for the content-workflow engine.',
  },
  async setup(services: MatbotServices) {
    services.tools.register(imageGenerateTool());
    console.log('[content] registered image_generate');
  },
};
