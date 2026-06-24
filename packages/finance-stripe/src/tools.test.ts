// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStripeTools } from './tools.js';
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

  return new Response(JSON.stringify({ error: { message: 'Not mocked' } }), {
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

test('stripe_balance tool returns balance data', async () => {
  setupFetchMocks();

  const mockBalance = {
    available: [{ amount: 12345, currency: 'usd' }],
    pending: [{ amount: 0, currency: 'usd' }],
  };

  fetchResponses.set('https://api.stripe.com/v1/balance',
    new Response(JSON.stringify(mockBalance), { status: 200 })
  );

  const ctx = mockCtx({ STRIPE_API_KEY: 'rk_test' });
  const tools = makeStripeTools();
  const balanceTool = tools.find((t) => t.name === 'stripe_balance');

  assert.ok(balanceTool);

  const results: Array<any> = [];
  for await (const result of balanceTool.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.balance.available[0].amount, 12345);
  assert.equal(results[0].value.balance.available[0].amount_decimal, 123.45);

  teardownFetchMocks();
});

test('stripe_transactions tool returns charges', async () => {
  setupFetchMocks();

  const mockCharges = {
    data: [
      {
        id: 'ch_1',
        amount: 5000,
        currency: 'usd',
        status: 'succeeded',
        paid: true,
        refunded: false,
        created: 1700000000,
        description: 'Order 1',
        receipt_email: 'a@b.com',
        billing_details: { name: 'Alice' },
      },
    ],
  };

  fetchResponses.set('https://api.stripe.com/v1/charges?limit=25',
    new Response(JSON.stringify(mockCharges), { status: 200 })
  );

  const ctx = mockCtx({ STRIPE_API_KEY: 'rk_test' });
  const tools = makeStripeTools();
  const txTool = tools.find((t) => t.name === 'stripe_transactions');

  assert.ok(txTool);

  const results: Array<any> = [];
  for await (const result of txTool.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.transactions.transactions.length, 1);
  assert.equal(results[0].value.transactions.transactions[0].id, 'ch_1');

  teardownFetchMocks();
});

test('stripe_transactions filters by status client-side', async () => {
  setupFetchMocks();

  const mockCharges = {
    data: [
      { id: 'ch_ok', amount: 1000, currency: 'usd', status: 'succeeded', paid: true, refunded: false, created: 1700000000 },
      { id: 'ch_fail', amount: 2000, currency: 'usd', status: 'failed', paid: false, refunded: false, created: 1700000001 },
    ],
  };

  fetchResponses.set('https://api.stripe.com/v1/charges?limit=25',
    new Response(JSON.stringify(mockCharges), { status: 200 })
  );

  const ctx = mockCtx({ STRIPE_API_KEY: 'rk_test' });
  const tools = makeStripeTools();
  const txTool = tools.find((t) => t.name === 'stripe_transactions');

  assert.ok(txTool);

  const results: Array<any> = [];
  for await (const result of txTool.executor.execute({ status: 'failed' }, ctx)) {
    results.push(result);
  }

  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.transactions.transactions.length, 1);
  assert.equal(results[0].value.transactions.transactions[0].id, 'ch_fail');

  teardownFetchMocks();
});

test('stripe_invoices tool returns invoices with status query', async () => {
  setupFetchMocks();

  const mockInvoices = {
    data: [
      {
        id: 'in_1',
        number: 'INV-001',
        status: 'open',
        currency: 'usd',
        amount_due: 10000,
        amount_paid: 0,
        amount_remaining: 10000,
        total: 10000,
        created: 1700000000,
        due_date: 1700600000,
        customer_email: 'c@d.com',
        customer_name: 'Bob',
        hosted_invoice_url: 'https://invoice.stripe.com/x',
      },
    ],
  };

  fetchResponses.set('https://api.stripe.com/v1/invoices?limit=25&status=open',
    new Response(JSON.stringify(mockInvoices), { status: 200 })
  );

  const ctx = mockCtx({ STRIPE_API_KEY: 'rk_test' });
  const tools = makeStripeTools();
  const invTool = tools.find((t) => t.name === 'stripe_invoices');

  assert.ok(invTool);

  const results: Array<any> = [];
  for await (const result of invTool.executor.execute({ status: 'open' }, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.invoices.invoices[0].number, 'INV-001');
  assert.equal(results[0].value.invoices.invoices[0].total_decimal, 100);

  teardownFetchMocks();
});

test('stripe_analytics tool returns aggregated rollup', async () => {
  setupFetchMocks();

  const mockCharges = {
    data: [
      { id: 'ch_1', amount: 1000, currency: 'usd', status: 'succeeded', refunded: false, amount_refunded: 0 },
      { id: 'ch_2', amount: 2000, currency: 'usd', status: 'succeeded', refunded: true, amount_refunded: 500 },
    ],
  };

  const fetchMatch = (url: string | URL, options?: RequestInit): Response => {
    const urlStr = String(url);
    fetchCalls.push({ url: urlStr, options });
    if (urlStr.startsWith('https://api.stripe.com/v1/charges?limit=100&created[gte]=')) {
      return new Response(JSON.stringify(mockCharges), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'Not mocked' } }), { status: 404 });
  };
  global.fetch = fetchMatch as any;

  const ctx = mockCtx({ STRIPE_API_KEY: 'rk_test' });
  const tools = makeStripeTools();
  const analyticsTool = tools.find((t) => t.name === 'stripe_analytics');

  assert.ok(analyticsTool);

  const results: Array<any> = [];
  for await (const result of analyticsTool.executor.execute({ since_days: 7 }, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  const usd = results[0].value.analytics.currencies.find((c: any) => c.currency === 'usd');
  assert.equal(usd.gross, 3000);
  assert.equal(usd.net, 2500);
  assert.equal(usd.refunded_count, 1);

  teardownFetchMocks();
});

test('stripe_balance returns error when API key is missing', async () => {
  setupFetchMocks();

  const ctx = mockCtx({});
  const tools = makeStripeTools();
  const balanceTool = tools.find((t) => t.name === 'stripe_balance');

  assert.ok(balanceTool);

  const results: Array<any> = [];
  for await (const result of balanceTool.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.match(results[0].message, /Missing secret/);

  teardownFetchMocks();
});
