// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { Trading212Client } from './client.js';

const PORTFOLIO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const ACCOUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const TRADES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max trades to fetch (default 50).' },
  },
};

export function makeTrading212Tools(): Tool[] {
  const portfolioTool: Tool = {
    name: 'trading212_portfolio',
    description:
      'Get your Trading 212 portfolio holdings and P&L. Requires TRADING212_API_KEY vault secret.',
    inputSchema: PORTFOLIO_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new Trading212Client(ctx);
        const result = await client.getPortfolio();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: result.data,
          };
        }
      },
    },
  };

  const accountTool: Tool = {
    name: 'trading212_account',
    description: 'Get your Trading 212 account balance and equity information.',
    inputSchema: ACCOUNT_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const client = new Trading212Client(ctx);
        const result = await client.getAccount();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: result.data,
          };
        }
      },
    },
  };

  const tradesTool: Tool = {
    name: 'trading212_trades',
    description: 'Get your recent Trading 212 trades and transaction history.',
    inputSchema: TRADES_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number };
        const client = new Trading212Client(ctx);
        const result = await client.getTrades(Number(args.limit) || 50);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              trades: result.data || [],
              count: Array.isArray(result.data) ? result.data.length : 0,
            },
          };
        }
      },
    },
  };

  return [portfolioTool, accountTool, tradesTool];
}
