// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { guardResult, capFromEnv } from './guard.js';

export { guardResult, capFromEnv } from './guard.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Tool-result guardrail: truncates any oversized tool result (default >50k chars; EIDAN_TOOL_RESULT_MAX_CHARS, 0 to disable) before it re-enters the LLM context, appending a notice so the model re-queries narrowly. Stops one huge result (e.g. a raw http API dump) from poisoning the conversation.',
  },

  async setup(services: MatbotServices) {
    const max = capFromEnv();
    if (max === 0) { console.log('[tool-guard] disabled (EIDAN_TOOL_RESULT_MAX_CHARS=0)'); return; }

    // toolresult is matbot's transform pipeline; low priority => we truncate early, before any
    // downstream toolresult transform (redaction etc.) works on the trimmed text.
    services.hooks.register({
      on: 'toolresult',
      priority: 20,
      pluginName: 'tool-guard',
      handler(ctx) {
        return guardResult(ctx.result, max, ctx.tool.name);
      },
    });

    console.log(`[tool-guard] tool-result cap = ${max.toLocaleString()} chars`);
  },
};
