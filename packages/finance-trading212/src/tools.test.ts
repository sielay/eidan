// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTrading212Tools } from './tools.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

let fetchCalls: Array<{ url: string; options: RequestInit | undefined }> = [];
let fetchResponses: Map<string, Response | Error> = new Map();

const mockFetch = (url: string | URL, options?: RequestInit): Response => {
  const urlStr = String(url);
  fetchCalls.push({ url: urlStr, options });

  if (fetchResponses.has(urlStr)) {
    const response = fetchResponses.get(urlStr)!;
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  return new Response(JSON.stringify({ error: 'Not mocked' }), {
    status: 404,
  });
};

const setupFetchMocks = () => {
  fetchCalls = [];
  fetchResponses.clear();
  global.fetch = mockFetch as any;
};

const teardownFetchMocks = () => {
  global.fetch = undefined as any;
};

const mockCtx = (secrets: Record<string, string | undefined> = {}): ToolContext => ({
  vault: {
    resolve: async (name: string) => {
      const key = name.replace(/^\$\{/, '').replace(/\}$/, '');
      const value = secrets[key];
      if (!value) throw new MissingSecretError(['KEY_NOT_FOUND']);
      return value;
    },
    writeSecret: async (key: string, value: string) => {
      secrets[key] = value;
    },
  },
} as any);

test('trading212_portfolio tool returns portfolio data', async () => {
  setupFetchMocks();

  const mockPortfolio = {
    positions: [
      {
        instrument_id: '1',
        symbol: 'AAPL',
        quantity: 10,
        average_price: 150,
        current_price: 155,
        current_value: 1550,
        pl_amount: 50,
        pl_percentage: 3.33,
      },
    ],
    total_value: 5000,
    cash: 3450,
    buying_power: 5000,
    total_pl: 50,
  };

  fetchResponses.set('https://api.trading212.com/v0/accounts/me/portfolio',
    new Response(JSON.stringify(mockPortfolio), { status: 200 })
  );

  const ctx = mockCtx({ TRADING212_API_KEY: 'test-key' });
  const tools = makeTrading212Tools();
  const portfolioTool = tools.find((t) => t.name === 'trading212_portfolio');

  assert.ok(portfolioTool);

  const results: Array<any> = [];
  for await (const result of portfolioTool.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.portfolio.total_value, 5000);
  assert.equal(results[0].value.portfolio.positions.length, 1);

  teardownFetchMocks();
});

test('trading212_account tool returns account info', async () => {
  setupFetchMocks();

  const mockAccount = {
    account: {
      account_id: 'acc123',
      account_type: 'INVEST',
      total_value: 5000,
      cash_balance: 1000,
      buying_power: 5000,
      currency: 'GBP',
    },
  };

  fetchResponses.set('https://api.trading212.com/v0/accounts/me',
    new Response(JSON.stringify(mockAccount), { status: 200 })
  );

  const ctx = mockCtx({ TRADING212_API_KEY: 'test-key' });
  const tools = makeTrading212Tools();
  const accountTool = tools.find((t) => t.name === 'trading212_account');

  assert.ok(accountTool);

  const results: Array<any> = [];
  for await (const result of accountTool.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.account.account_id, 'acc123');

  teardownFetchMocks();
});

test('trading212_trades tool returns trades', async () => {
  setupFetchMocks();

  const mockTrades = {
    trades: [
      {
        order_id: 'ord1',
        symbol: 'AAPL',
        side: 'BUY',
        quantity: 10,
        price: 150,
        executed_at: '2024-06-01T10:00:00Z',
        commission: 0,
        status: 'FILLED',
      },
    ],
    total: 1,
  };

  fetchResponses.set('https://api.trading212.com/v0/accounts/me/trades?limit=50',
    new Response(JSON.stringify(mockTrades), { status: 200 })
  );

  const ctx = mockCtx({ TRADING212_API_KEY: 'test-key' });
  const tools = makeTrading212Tools();
  const tradesTool = tools.find((t) => t.name === 'trading212_trades');

  assert.ok(tradesTool);

  const results: Array<any> = [];
  for await (const result of tradesTool.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.trades.trades.length, 1);

  teardownFetchMocks();
});

test('trading212_portfolio returns error when API key is missing', async () => {
  setupFetchMocks();

  const ctx = mockCtx({});
  const tools = makeTrading212Tools();
  const portfolioTool = tools.find((t) => t.name === 'trading212_portfolio');

  assert.ok(portfolioTool);

  const results: Array<any> = [];
  for await (const result of portfolioTool.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.match(results[0].message, /Missing secret/);

  teardownFetchMocks();
});

test('trading212_trades accepts limit and symbol parameters', async () => {
  setupFetchMocks();

  const mockTrades = {
    trades: [
      {
        order_id: 'ord1',
        symbol: 'MSFT',
        side: 'SELL',
        quantity: 5,
        price: 380,
        executed_at: '2024-06-01T11:00:00Z',
        commission: 1.5,
        status: 'FILLED',
      },
    ],
    total: 1,
  };

  fetchResponses.set('https://api.trading212.com/v0/accounts/me/trades?limit=25&symbol=MSFT',
    new Response(JSON.stringify(mockTrades), { status: 200 })
  );

  const ctx = mockCtx({ TRADING212_API_KEY: 'test-key' });
  const tools = makeTrading212Tools();
  const tradesTool = tools.find((t) => t.name === 'trading212_trades');

  assert.ok(tradesTool);

  const results: Array<any> = [];
  for await (const result of tradesTool.executor.execute({ limit: 25, symbol: 'msft' }, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.trades.trades[0].symbol, 'MSFT');

  teardownFetchMocks();
});
