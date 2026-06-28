// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { getOpenRouterSpend } from './client.js';

const SCHEMA_EMPTY = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export function makeSpendAnalyticsTools(): Tool[] {
  const openrouterTool: Tool = {
    name: 'openrouter_spend_analytics',
    description:
      'Get OpenRouter trailing 30-day cloud spend breakdown including total spend, spend by model, input vs output token costs, cache hit rate (if available), and 7-day/30-day trends for hardware buy-decision evaluation. Returns spend in USD or GBP depending on account currency. Requires OPENROUTER_API_KEY vault secret.',
    inputSchema: SCHEMA_EMPTY,
    executor: {
      async *execute(_input: any, ctx: ToolContext) {
        const result = await getOpenRouterSpend(ctx);
        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield { type: 'result', value: result.data };
        } else {
          yield { type: 'error', message: 'No spend data received' };
        }
      },
    },
  };

  return [openrouterTool];
}
