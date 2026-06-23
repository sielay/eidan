// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { createClient } from './client.js';

const BALANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const TRANSACTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max charges to return (default 25).',
    },
    status: {
      type: 'string',
      enum: ['succeeded', 'pending', 'failed'],
      description: 'Optional: filter charges by status (client-side).',
    },
  },
};

const INVOICES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max invoices to return (default 25).',
    },
    status: {
      type: 'string',
      enum: ['open', 'paid', 'draft', 'uncollectible', 'void'],
      description: 'Optional: filter invoices by status.',
    },
  },
};

const ANALYTICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    since_days: {
      type: 'integer',
      minimum: 1,
      maximum: 365,
      description: 'Number of days back to aggregate revenue over (default 30).',
    },
  },
};

const TIMESERIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    since_days: {
      type: 'integer',
      minimum: 1,
      maximum: 365,
      description: 'Number of days back to cover (default 30).',
    },
    interval: {
      type: 'string',
      enum: ['day', 'week', 'month'],
      description: 'Bucket size for the revenue trend (default day).',
    },
  },
};

const SUBSCRIPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'all'],
      description: 'Subscription status to list (default active).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max subscriptions to return (default 100).',
    },
  },
};

const PAYOUTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max payouts to return (default 25).',
    },
  },
};

export function makeStripeTools(): Tool[] {
  const balanceTool: Tool = {
    name: 'stripe_balance',
    description:
      'Get your current Stripe account balance. Returns available and pending funds per currency (raw integer amount in the smallest unit, plus a decimal convenience and currency). Read-only. Requires STRIPE_API_KEY vault secret.',
    inputSchema: BALANCE_SCHEMA,
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
            message: 'Stripe client initialization failed',
          };
          return;
        }

        const result = await clientResult.client.getBalance();

        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: {
              balance: {
                available: result.data.available.map((b) => ({
                  amount: b.amount,
                  amount_decimal: b.amount_decimal,
                  currency: b.currency,
                })),
                pending: result.data.pending.map((b) => ({
                  amount: b.amount,
                  amount_decimal: b.amount_decimal,
                  currency: b.currency,
                })),
              },
            },
          };
        } else {
          yield {
            type: 'error',
            message: 'No balance data received',
          };
        }
      },
    },
  };

  const transactionsTool: Tool = {
    name: 'stripe_transactions',
    description:
      'Get recent Stripe charges/transactions. Returns id, amount (smallest unit) + decimal + currency, status, paid/refunded flags, creation date, description, and payer details. Optionally filter by status. Read-only. Requires STRIPE_API_KEY vault secret.',
    inputSchema: TRANSACTIONS_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; status?: string };
        const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
        const status = args.status ? String(args.status) : undefined;

        const clientResult = await createClient(ctx);

        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }

        if (!clientResult.client) {
          yield {
            type: 'error',
            message: 'Stripe client initialization failed',
          };
          return;
        }

        const result = await clientResult.client.getTransactions(limit);

        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          let transactions = result.data.transactions;
          if (status) {
            transactions = transactions.filter((t) => t.status === status);
          }
          yield {
            type: 'result',
            value: {
              transactions: {
                total: transactions.length,
                transactions: transactions.map((t) => ({
                  id: t.id,
                  amount: t.amount,
                  amount_decimal: t.amount_decimal,
                  currency: t.currency,
                  status: t.status,
                  paid: t.paid,
                  refunded: t.refunded,
                  created_at: t.created_at,
                  description: t.description,
                  receipt_email: t.receipt_email,
                  customer_name: t.customer_name,
                })),
              },
            },
          };
        } else {
          yield {
            type: 'error',
            message: 'No transactions data received',
          };
        }
      },
    },
  };

  const invoicesTool: Tool = {
    name: 'stripe_invoices',
    description:
      'Get recent Stripe invoices. Returns id, number, status, currency, amounts (due/paid/remaining/total in smallest unit + decimal), creation and due dates, customer email/name, and hosted invoice URL. Optionally filter by status. Read-only. Requires STRIPE_API_KEY vault secret.',
    inputSchema: INVOICES_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; status?: string };
        const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
        const status = args.status ? String(args.status) : undefined;

        const clientResult = await createClient(ctx);

        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }

        if (!clientResult.client) {
          yield {
            type: 'error',
            message: 'Stripe client initialization failed',
          };
          return;
        }

        const result = await clientResult.client.getInvoices(limit, status);

        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: {
              invoices: {
                total: result.data.total,
                invoices: result.data.invoices.map((i) => ({
                  id: i.id,
                  number: i.number,
                  status: i.status,
                  currency: i.currency,
                  amount_due: i.amount_due,
                  amount_paid: i.amount_paid,
                  amount_remaining: i.amount_remaining,
                  total: i.total,
                  amount_due_decimal: i.amount_due_decimal,
                  amount_paid_decimal: i.amount_paid_decimal,
                  amount_remaining_decimal: i.amount_remaining_decimal,
                  total_decimal: i.total_decimal,
                  created_at: i.created_at,
                  due_date_at: i.due_date_at,
                  customer_email: i.customer_email,
                  customer_name: i.customer_name,
                  hosted_invoice_url: i.hosted_invoice_url,
                })),
              },
            },
          };
        } else {
          yield {
            type: 'error',
            message: 'No invoices data received',
          };
        }
      },
    },
  };

  const analyticsTool: Tool = {
    name: 'stripe_analytics',
    description:
      'Get a Stripe revenue rollup over a recent window. Aggregates charges per currency into gross, net (gross minus refunds), decimals, average transaction value, refund rate, and counts (total / succeeded / refunded). Scans up to ~1000 charges; flags `capped` when older charges in the window were not scanned. Read-only. Requires STRIPE_API_KEY vault secret.',
    inputSchema: ANALYTICS_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { since_days?: number };
        const sinceDays = Math.min(Math.max(Number(args.since_days) || 30, 1), 365);

        const clientResult = await createClient(ctx);

        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }

        if (!clientResult.client) {
          yield {
            type: 'error',
            message: 'Stripe client initialization failed',
          };
          return;
        }

        const result = await clientResult.client.getAnalytics(sinceDays);

        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: {
              analytics: {
                since_at: result.data.since_at,
                charge_count: result.data.charge_count,
                capped: result.data.capped,
                currencies: result.data.currencies.map((c) => ({
                  currency: c.currency,
                  gross: c.gross,
                  net: c.net,
                  gross_decimal: c.gross_decimal,
                  net_decimal: c.net_decimal,
                  count: c.count,
                  succeeded_count: c.succeeded_count,
                  refunded_count: c.refunded_count,
                  avg_transaction: c.avg_transaction,
                  avg_transaction_decimal: c.avg_transaction_decimal,
                  refund_rate: c.refund_rate,
                })),
              },
            },
          };
        } else {
          yield {
            type: 'error',
            message: 'No analytics data received',
          };
        }
      },
    },
  };

  const timeseriesTool: Tool = {
    name: 'stripe_revenue_timeseries',
    description:
      'Get a Stripe revenue trend over time, bucketed by day, week, or month, per currency (gross, net, count + decimals). Use to see how revenue is moving, not just a single total. Scans up to ~1000 charges; flags `capped` when the window is larger. Read-only. Requires STRIPE_API_KEY vault secret.',
    inputSchema: TIMESERIES_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { since_days?: number; interval?: 'day' | 'week' | 'month' };
        const sinceDays = Math.min(Math.max(Number(args.since_days) || 30, 1), 365);
        const interval = args.interval ?? 'day';

        const clientResult = await createClient(ctx);

        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }

        if (!clientResult.client) {
          yield { type: 'error', message: 'Stripe client initialization failed' };
          return;
        }

        const result = await clientResult.client.getRevenueTimeseries({ sinceDays, interval });

        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: {
              timeseries: {
                interval: result.data.interval,
                since_at: result.data.since_at,
                capped: result.data.capped,
                buckets: result.data.buckets.map((b) => ({
                  period: b.period,
                  currency: b.currency,
                  gross: b.gross,
                  net: b.net,
                  gross_decimal: b.gross_decimal,
                  net_decimal: b.net_decimal,
                  count: b.count,
                })),
              },
            },
          };
        } else {
          yield { type: 'error', message: 'No timeseries data received' };
        }
      },
    },
  };

  const subscriptionsTool: Tool = {
    name: 'stripe_subscriptions',
    description:
      'List Stripe subscriptions and the recurring revenue they represent. Returns each subscription (status, customer, billing interval, quantity, period end, cancel-at-period-end) with its normalised MRR, plus an MRR-per-currency rollup across active/trialing subs. Use for recurring-revenue / churn questions. Read-only. Requires STRIPE_API_KEY vault secret.',
    inputSchema: SUBSCRIPTIONS_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { status?: string; limit?: number };
        const status = args.status ? String(args.status) : undefined;
        const limit = args.limit ? Math.min(Math.max(Number(args.limit), 1), 100) : undefined;

        const clientResult = await createClient(ctx);
        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }
        if (!clientResult.client) {
          yield { type: 'error', message: 'Stripe client initialization failed' };
          return;
        }

        const result = await clientResult.client.getSubscriptions({
          ...(status ? { status } : {}),
          ...(limit ? { limit } : {}),
        });
        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: {
              subscriptions: {
                total: result.data.total,
                capped: result.data.capped,
                mrr_by_currency: result.data.mrr_by_currency,
                subscriptions: result.data.subscriptions,
              },
            },
          };
        } else {
          yield { type: 'error', message: 'No subscriptions data received' };
        }
      },
    },
  };

  const payoutsTool: Tool = {
    name: 'stripe_payouts',
    description:
      'List recent Stripe payouts — money transferred from the Stripe balance to your bank. Returns id, amount (smallest unit + decimal) + currency, status, type/method, description, arrival date, and creation date. Use to see cash actually landing in the bank (vs gross charges). Read-only. Requires STRIPE_API_KEY vault secret.',
    inputSchema: PAYOUTS_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number };
        const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);

        const clientResult = await createClient(ctx);
        if (clientResult.error) {
          yield { type: 'error', message: clientResult.error.message };
          return;
        }
        if (!clientResult.client) {
          yield { type: 'error', message: 'Stripe client initialization failed' };
          return;
        }

        const result = await clientResult.client.getPayouts(limit);
        if (result.error) {
          yield { type: 'error', message: result.error.message };
        } else if (result.data) {
          yield {
            type: 'result',
            value: { payouts: { total: result.data.total, payouts: result.data.payouts } },
          };
        } else {
          yield { type: 'error', message: 'No payouts data received' };
        }
      },
    },
  };

  return [
    balanceTool,
    transactionsTool,
    invoicesTool,
    analyticsTool,
    timeseriesTool,
    subscriptionsTool,
    payoutsTool,
  ];
}
