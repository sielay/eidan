// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StripeClient, createClient } from './client.js';
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

test('StripeClient.request sends Bearer auth header', async () => {
  setupFetchMocks();

  fetchResponses.set('https://api.stripe.com/v1/balance',
    new Response(JSON.stringify({ available: [], pending: [] }), { status: 200 })
  );

  const ctx = mockCtx();
  const client = new StripeClient(ctx, 'rk_test_123');
  await client.getBalance();

  assert.equal(fetchCalls.length, 1);
  const headers = fetchCalls[0]!.options?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer rk_test_123');

  teardownFetchMocks();
});

test('StripeClient.getBalance parses available and pending', async () => {
  setupFetchMocks();

  const mockBalance = {
    available: [{ amount: 12345, currency: 'usd' }],
    pending: [{ amount: 6789, currency: 'usd' }],
  };

  fetchResponses.set('https://api.stripe.com/v1/balance',
    new Response(JSON.stringify(mockBalance), { status: 200 })
  );

  const ctx = mockCtx();
  const client = new StripeClient(ctx, 'rk_test');
  const result = await client.getBalance();

  assert.ok(!result.error);
  assert.ok(result.data);
  assert.equal(result.data.available.length, 1);
  assert.equal(result.data.available[0]!.amount, 12345);
  assert.equal(result.data.available[0]!.amount_decimal, 123.45);
  assert.equal(result.data.available[0]!.currency, 'usd');
  assert.equal(result.data.pending[0]!.amount, 6789);

  teardownFetchMocks();
});

test('StripeClient.getTransactions parses charges and converts dates', async () => {
  setupFetchMocks();

  const mockCharges = {
    data: [
      {
        id: 'ch_1',
        amount: 5000,
        currency: 'gbp',
        status: 'succeeded',
        paid: true,
        refunded: false,
        created: 1700000000,
        description: 'Order 123',
        receipt_email: 'a@b.com',
        billing_details: { name: 'Alice' },
      },
    ],
  };

  fetchResponses.set('https://api.stripe.com/v1/charges?limit=25',
    new Response(JSON.stringify(mockCharges), { status: 200 })
  );

  const ctx = mockCtx();
  const client = new StripeClient(ctx, 'rk_test');
  const result = await client.getTransactions(25);

  assert.ok(!result.error);
  assert.ok(result.data);
  assert.equal(result.data.transactions.length, 1);
  const t = result.data.transactions[0]!;
  assert.equal(t.id, 'ch_1');
  assert.equal(t.amount, 5000);
  assert.equal(t.amount_decimal, 50);
  assert.equal(t.currency, 'gbp');
  assert.equal(t.customer_name, 'Alice');
  assert.equal(t.created_at, new Date(1700000000 * 1000).toISOString());

  teardownFetchMocks();
});

test('StripeClient.getInvoices parses invoices with status filter', async () => {
  setupFetchMocks();

  const mockInvoices = {
    data: [
      {
        id: 'in_1',
        number: 'INV-001',
        status: 'paid',
        currency: 'usd',
        amount_due: 0,
        amount_paid: 10000,
        amount_remaining: 0,
        total: 10000,
        created: 1700000000,
        due_date: null,
        customer_email: 'c@d.com',
        customer_name: 'Bob',
        hosted_invoice_url: 'https://invoice.stripe.com/x',
      },
    ],
  };

  fetchResponses.set('https://api.stripe.com/v1/invoices?limit=25&status=paid',
    new Response(JSON.stringify(mockInvoices), { status: 200 })
  );

  const ctx = mockCtx();
  const client = new StripeClient(ctx, 'rk_test');
  const result = await client.getInvoices(25, 'paid');

  assert.ok(!result.error);
  assert.ok(result.data);
  assert.equal(result.data.invoices.length, 1);
  const i = result.data.invoices[0]!;
  assert.equal(i.number, 'INV-001');
  assert.equal(i.total, 10000);
  assert.equal(i.total_decimal, 100);
  assert.equal(i.due_date_at, null);
  assert.equal(i.hosted_invoice_url, 'https://invoice.stripe.com/x');

  teardownFetchMocks();
});

test('StripeClient.getAnalytics aggregates per currency', async () => {
  setupFetchMocks();

  const mockCharges = {
    data: [
      { id: 'ch_1', amount: 1000, currency: 'usd', status: 'succeeded', refunded: false, amount_refunded: 0 },
      { id: 'ch_2', amount: 2000, currency: 'usd', status: 'succeeded', refunded: true, amount_refunded: 500 },
      { id: 'ch_3', amount: 3000, currency: 'gbp', status: 'failed', refunded: false, amount_refunded: 0 },
    ],
  };

  // Match the analytics URL prefix regardless of the exact since timestamp.
  const fetchMatch = (url: string | URL, options?: RequestInit): Response => {
    const urlStr = String(url);
    fetchCalls.push({ url: urlStr, options });
    if (urlStr.startsWith('https://api.stripe.com/v1/charges?limit=100&created[gte]=')) {
      return new Response(JSON.stringify(mockCharges), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'Not mocked' } }), { status: 404 });
  };
  global.fetch = fetchMatch as any;

  const ctx = mockCtx();
  const client = new StripeClient(ctx, 'rk_test');
  const result = await client.getAnalytics(30);

  assert.ok(!result.error);
  assert.ok(result.data);
  const usd = result.data.currencies.find((c) => c.currency === 'usd');
  const gbp = result.data.currencies.find((c) => c.currency === 'gbp');
  assert.ok(usd);
  assert.equal(usd!.count, 2);
  assert.equal(usd!.gross, 3000);
  assert.equal(usd!.net, 2500); // 3000 gross - 500 refunded
  assert.equal(usd!.succeeded_count, 2);
  assert.equal(usd!.refunded_count, 1);
  assert.ok(gbp);
  assert.equal(gbp!.succeeded_count, 0);

  teardownFetchMocks();
});

test('StripeClient.getAnalytics derives decimals, average and refund rate', async () => {
  fetchCalls = [];
  const mockCharges = {
    data: [
      { id: 'ch_1', amount: 1000, currency: 'usd', status: 'succeeded', refunded: false, amount_refunded: 0 },
      { id: 'ch_2', amount: 3000, currency: 'usd', status: 'succeeded', refunded: true, amount_refunded: 500 },
    ],
  };
  global.fetch = ((url: string | URL): Response => {
    if (String(url).startsWith('https://api.stripe.com/v1/charges?limit=100&created[gte]=')) {
      return new Response(JSON.stringify(mockCharges), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as any;

  const client = new StripeClient(mockCtx(), 'rk_test');
  const result = await client.getAnalytics(30);
  const usd = result.data!.currencies.find((c) => c.currency === 'usd')!;
  assert.equal(usd.gross, 4000);
  assert.equal(usd.gross_decimal, 40);
  assert.equal(usd.net_decimal, 35); // (4000 - 500) / 100
  assert.equal(usd.avg_transaction, 2000); // 4000 / 2
  assert.equal(usd.avg_transaction_decimal, 20);
  assert.equal(usd.refund_rate, 0.5); // 1 of 2
  assert.equal(result.data!.charge_count, 2);
  assert.equal(result.data!.capped, false);

  teardownFetchMocks();
});

test('StripeClient.getRevenueTimeseries buckets by interval and currency', async () => {
  fetchCalls = [];
  // Two charges on 2023-11-14, one on 2023-11-15 (UTC).
  const day14 = Math.floor(Date.parse('2023-11-14T10:00:00Z') / 1000);
  const day15 = Math.floor(Date.parse('2023-11-15T10:00:00Z') / 1000);
  const mockCharges = {
    data: [
      { id: 'ch_1', amount: 1000, currency: 'usd', created: day14, amount_refunded: 0 },
      { id: 'ch_2', amount: 2000, currency: 'usd', created: day14, amount_refunded: 0 },
      { id: 'ch_3', amount: 5000, currency: 'usd', created: day15, amount_refunded: 1000 },
    ],
  };
  global.fetch = ((url: string | URL): Response => {
    if (String(url).startsWith('https://api.stripe.com/v1/charges?limit=100&created[gte]=')) {
      return new Response(JSON.stringify(mockCharges), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as any;

  const client = new StripeClient(mockCtx(), 'rk_test');
  const result = await client.getRevenueTimeseries({ sinceDays: 60, interval: 'day' });
  assert.ok(!result.error);
  assert.equal(result.data!.interval, 'day');
  const b14 = result.data!.buckets.find((b) => b.period === '2023-11-14')!;
  const b15 = result.data!.buckets.find((b) => b.period === '2023-11-15')!;
  assert.equal(b14.gross, 3000);
  assert.equal(b14.count, 2);
  assert.equal(b14.gross_decimal, 30);
  assert.equal(b15.net, 4000); // 5000 - 1000 refunded
  assert.equal(b15.net_decimal, 40);
  // Sorted ascending by period.
  assert.equal(result.data!.buckets[0]!.period, '2023-11-14');

  teardownFetchMocks();
});

test('StripeClient.getSubscriptions computes per-sub MRR and a currency rollup', async () => {
  setupFetchMocks();
  const mockSubs = {
    has_more: false,
    data: [
      {
        id: 'sub_1', status: 'active', currency: 'usd', customer: { id: 'cus_1', name: 'Acme' },
        items: { data: [{ quantity: 2, price: { id: 'price_1', currency: 'usd', unit_amount: 1000, recurring: { interval: 'month', interval_count: 1 } } }] },
      },
      {
        id: 'sub_2', status: 'active', currency: 'usd', customer: { id: 'cus_2', name: 'Beta' },
        // annual £12000/yr -> £1000/mo
        items: { data: [{ quantity: 1, price: { id: 'price_2', currency: 'usd', unit_amount: 12000, recurring: { interval: 'year', interval_count: 1 } } }] },
      },
      {
        id: 'sub_3', status: 'canceled', currency: 'usd', customer: { id: 'cus_3', name: 'Gone' },
        items: { data: [{ quantity: 1, price: { id: 'price_3', currency: 'usd', unit_amount: 5000, recurring: { interval: 'month', interval_count: 1 } } }] },
      },
    ],
  };
  fetchResponses.set(
    'https://api.stripe.com/v1/subscriptions?limit=100&status=active&expand[]=data.customer',
    new Response(JSON.stringify(mockSubs), { status: 200 }),
  );

  const client = new StripeClient(mockCtx(), 'rk_test');
  const result = await client.getSubscriptions();
  assert.ok(!result.error);
  const data = result.data!;
  const sub1 = data.subscriptions.find((s) => s.id === 'sub_1')!;
  assert.equal(sub1.mrr, 2000); // 1000 * 2 monthly
  assert.equal(sub1.customer_name, 'Acme');
  const sub2 = data.subscriptions.find((s) => s.id === 'sub_2')!;
  assert.equal(sub2.mrr, 1000); // 12000 / 12
  // Rollup excludes the canceled sub.
  const usd = data.mrr_by_currency.find((c) => c.currency === 'usd')!;
  assert.equal(usd.mrr, 3000);
  assert.equal(usd.mrr_decimal, 30);
  assert.equal(usd.active_count, 2);

  teardownFetchMocks();
});

test('StripeClient.getPayouts parses payouts and converts dates', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://api.stripe.com/v1/payouts?limit=25',
    new Response(JSON.stringify({ data: [{ id: 'po_1', amount: 50000, currency: 'gbp', status: 'paid', type: 'bank_account', method: 'standard', arrival_date: 1700000000, created: 1699990000 }] }), { status: 200 }),
  );
  const client = new StripeClient(mockCtx(), 'rk_test');
  const result = await client.getPayouts(25);
  assert.ok(!result.error);
  const p = result.data!.payouts[0]!;
  assert.equal(p.amount, 50000);
  assert.equal(p.amount_decimal, 500);
  assert.equal(p.status, 'paid');
  assert.equal(p.arrival_date_at, new Date(1700000000 * 1000).toISOString());

  teardownFetchMocks();
});

test('StripeClient.getBalance returns error on API failure with error.message', async () => {
  setupFetchMocks();

  fetchResponses.set('https://api.stripe.com/v1/balance',
    new Response(JSON.stringify({ error: { message: 'Invalid API Key provided', type: 'invalid_request_error' } }), { status: 401 })
  );

  const ctx = mockCtx();
  const client = new StripeClient(ctx, 'bad-key');
  const result = await client.getBalance();

  assert.ok(result.error);
  assert.equal(result.error?.status, 401);
  assert.match(result.error!.message, /Invalid API Key provided/);

  teardownFetchMocks();
});

test('createClient returns error when API key is missing', async () => {
  const ctx = mockCtx({});
  const result = await createClient(ctx);

  assert.ok(result.error);
  assert.match(result.error?.message, /Missing secret/);
});

test('createClient returns client when API key is available', async () => {
  const ctx = mockCtx({ STRIPE_API_KEY: 'rk_test' });
  const result = await createClient(ctx);

  assert.ok(!result.error);
  assert.ok(result.client);
});
