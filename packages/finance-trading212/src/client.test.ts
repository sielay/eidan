// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Trading212Client, createClient } from './client.js';
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

test('Trading212Client.getPortfolio returns positions on success', async () => {
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

  const ctx = mockCtx();
  const client = new Trading212Client(ctx, 'test-api-key');
  const result = await client.getPortfolio();

  assert.ok(!result.error);
  assert.ok(result.data);
  assert.equal(result.data?.positions.length, 1);
  assert.equal(result.data?.positions[0].symbol, 'AAPL');
  assert.equal(result.data?.total_value, 5000);

  teardownFetchMocks();
});

test('Trading212Client.getAccount returns account info on success', async () => {
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

  const ctx = mockCtx();
  const client = new Trading212Client(ctx, 'test-api-key');
  const result = await client.getAccount();

  assert.ok(!result.error);
  assert.ok(result.data);
  assert.equal(result.data?.account.account_id, 'acc123');
  assert.equal(result.data?.account.currency, 'GBP');

  teardownFetchMocks();
});

test('Trading212Client.getTrades returns trades on success', async () => {
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

  const ctx = mockCtx();
  const client = new Trading212Client(ctx, 'test-api-key');
  const result = await client.getTrades(50);

  assert.ok(!result.error);
  assert.ok(result.data);
  assert.equal(result.data?.trades.length, 1);
  assert.equal(result.data?.trades[0].symbol, 'AAPL');

  teardownFetchMocks();
});

test('Trading212Client.getPortfolio returns error on API failure', async () => {
  setupFetchMocks();

  fetchResponses.set('https://api.trading212.com/v0/accounts/me/portfolio',
    new Response('Unauthorized', { status: 401 })
  );

  const ctx = mockCtx();
  const client = new Trading212Client(ctx, 'bad-api-key');
  const result = await client.getPortfolio();

  assert.ok(result.error);
  assert.equal(result.error?.status, 401);

  teardownFetchMocks();
});

test('createClient returns error when API key is missing', async () => {
  const ctx = mockCtx({});
  const result = await createClient(ctx);

  assert.ok(result.error);
  assert.match(result.error?.message, /Missing secret/);
});

test('createClient returns client when API key is available', async () => {
  const ctx = mockCtx({ TRADING212_API_KEY: 'test-key' });
  const result = await createClient(ctx);

  assert.ok(!result.error);
  assert.ok(result.client);
});
