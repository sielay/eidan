// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { createClient } from './client.js';

const PORTFOLIO_SCHEMA = {
  type: 'object',
  properties: {
    total_value: { type: 'number', description: 'Total portfolio value' },
    cash: { type: 'number', description: 'Available cash balance' },
    buying_power: { type: 'number', description: 'Buying power available' },
    total_pl: { type: 'number', description: 'Total profit/loss' },
    positions: {
      type: 'array',
      description: 'Array of current positions',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Stock symbol' },
          quantity: { type: 'number', description: 'Number of shares' },
          average_price: { type: 'number', description: 'Average purchase price' },
          current_price: { type: 'number', description: 'Current market price' },
          current_value: { type: 'number', description: 'Total current value' },
          pl_amount: { type: 'number', description: 'Profit/loss amount' },
          pl_percentage: { type: 'number', description: 'Profit/loss percentage' },
        },
      },
    },
  },
};

const ACCOUNT_SCHEMA = {
  type: 'object',
  properties: {
    account_id: { type: 'string', description: 'Trading 212 account ID' },
    account_type: { type: 'string', description: 'Account type (INVEST, ISA, etc)' },
    total_value: { type: 'number', description: 'Total account value' },
    cash_balance: { type: 'number', description: 'Available cash' },
    buying_power: { type: 'number', description: 'Available buying power' },
    currency: { type: 'string', description: 'Account currency' },
  },
};

const TRADES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max trades to return (default 50).',
    },
    symbol: {
      type: 'string',
      description: 'Optional: filter by stock symbol (e.g., AAPL, MSFT).',
    },
  },
};

export function makeTrading212Tools(): Tool[] {
  const portfolioTool: Tool = {
    name: 'trading212_portfolio',
    description:
      'Get your Trading 212 portfolio holdings. Returns current positions with average price, current price, and profit/loss for each instrument. Requires TRADING212_API_KEY vault secret.',
    inputSchema: PORTFOLIO_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const clientResult = await createClient(ctx);

        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }

        if (!clientResult.client) {
          yield {
            type: 'error',
            message: 'Trading 212 client initialization failed',
          };
          return;
        }

        const result = await clientResult.client.getPortfolio();

        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: {
              portfolio: {
                total_value: result.data.total_value,
                cash: result.data.cash,
                buying_power: result.data.buying_power,
                total_pl: result.data.total_pl,
                positions: result.data.positions.map((p) => ({
                  symbol: p.symbol,
                  quantity: p.quantity,
                  average_price: p.average_price,
                  current_price: p.current_price,
                  current_value: p.current_value,
                  pl_amount: p.pl_amount,
                  pl_percentage: p.pl_percentage,
                })),
              },
            },
          };
        } else {
          yield {
            type: 'error',
            message: 'No portfolio data received',
          };
        }
      },
    },
  };

  const accountTool: Tool = {
    name: 'trading212_account',
    description:
      'Get your Trading 212 account information. Returns total value, cash balance, buying power, and account type. Requires TRADING212_API_KEY vault secret.',
    inputSchema: ACCOUNT_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const clientResult = await createClient(ctx);

        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }

        if (!clientResult.client) {
          yield {
            type: 'error',
            message: 'Trading 212 client initialization failed',
          };
          return;
        }

        const result = await clientResult.client.getAccount();

        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: {
              account: {
                account_id: result.data.account.account_id,
                account_type: result.data.account.account_type,
                total_value: result.data.account.total_value,
                cash_balance: result.data.account.cash_balance,
                buying_power: result.data.account.buying_power,
                currency: result.data.account.currency,
              },
            },
          };
        } else {
          yield {
            type: 'error',
            message: 'No account data received',
          };
        }
      },
    },
  };

  const tradesTool: Tool = {
    name: 'trading212_trades',
    description:
      'Get your recent Trading 212 trades/order history. Returns buy/sell orders with price, quantity, and execution date. Optionally filter by stock symbol. Requires TRADING212_API_KEY vault secret.',
    inputSchema: TRADES_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; symbol?: string };
        const limit = Math.min(Number(args.limit) || 50, 100);
        const symbol = args.symbol ? String(args.symbol).toUpperCase() : undefined;

        const clientResult = await createClient(ctx);

        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }

        if (!clientResult.client) {
          yield {
            type: 'error',
            message: 'Trading 212 client initialization failed',
          };
          return;
        }

        const result = await clientResult.client.getTrades(limit, symbol);

        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: {
              trades: {
                total: result.data.total,
                trades: result.data.trades.map((t) => ({
                  order_id: t.order_id,
                  symbol: t.symbol,
                  side: t.side,
                  quantity: t.quantity,
                  price: t.price,
                  executed_at: t.executed_at,
                  commission: t.commission,
                  status: t.status,
                })),
              },
            },
          };
        } else {
          yield {
            type: 'error',
            message: 'No trades data received',
          };
        }
      },
    },
  };

  return [portfolioTool, accountTool, tradesTool];
}
