// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type {
  BalanceResponse,
  TransactionsResponse,
  InvoicesResponse,
  AnalyticsSummary,
  CurrencyAnalytics,
  RevenueTimeseries,
  TimeseriesBucket,
  ApiError,
} from './types.js';

const API_BASE = 'https://api.stripe.com/v1';
// Stripe lists return at most 100 per page; we page with `starting_after` up to this many pages so
// analytics over a window can scan more than 100 charges. Beyond this the scan is flagged `capped`.
const MAX_ANALYTICS_PAGES = 10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The UTC period key a unix charge falls into, for the requested interval.
function periodKey(unix: number, interval: 'day' | 'week' | 'month'): string {
  const d = new Date(unix * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (interval === 'month') return `${y}-${m}`;
  if (interval === 'week') {
    // ISO-ish: snap back to Monday (UTC).
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const back = (day + 6) % 7; // days since Monday
    const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - back));
    return monday.toISOString().slice(0, 10);
  }
  return `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function toDecimal(amount: number | null): number | null {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return null;
  return amount / 100;
}

function toIso(unix: number | null | undefined): string | null {
  if (unix === null || unix === undefined || Number.isNaN(unix)) return null;
  return new Date(unix * 1000).toISOString();
}

export class StripeClient {
  private apiKey: string;
  private ctx: ToolContext;

  constructor(ctx: ToolContext, apiKey: string) {
    this.ctx = ctx;
    this.apiKey = apiKey;
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<{ data?: T; error?: ApiError }> {
    try {
      const url = `${API_BASE}${endpoint}`;
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...options?.headers,
        },
      });

      if (!res.ok) {
        let message = `Stripe API error: ${res.status}`;
        try {
          const body = (await res.json()) as { error?: { message?: string; type?: string; code?: string } };
          if (body?.error?.message) {
            message = `Stripe API error: ${res.status} ${body.error.message}`;
          }
        } catch {
          const errorText = await res.text().catch(() => '');
          if (errorText) message = `Stripe API error: ${res.status} ${errorText}`;
        }
        return {
          error: {
            status: res.status,
            message,
          },
        };
      }

      const data = (await res.json()) as T;
      return { data };
    } catch (exc) {
      return {
        error: {
          message: `Network error: ${exc instanceof Error ? exc.message : 'Unknown'}`,
        },
      };
    }
  }

  async getBalance(): Promise<{ data?: BalanceResponse; error?: ApiError }> {
    const result = await this.request<any>('/balance');

    if (result.error) {
      return { error: result.error };
    }

    if (!result.data) {
      return {
        error: {
          message: 'Empty balance response',
        },
      };
    }

    const mapAmounts = (items: any[] | undefined) =>
      (items ?? []).map((b: any) => ({
        amount: Number(b.amount) || 0,
        amount_decimal: toDecimal(Number(b.amount) || 0) ?? 0,
        currency: String(b.currency || 'usd'),
      }));

    return {
      data: {
        available: mapAmounts(result.data.available),
        pending: mapAmounts(result.data.pending),
      },
    };
  }

  async getTransactions(
    limit: number = 25,
    opts?: { since?: number }
  ): Promise<{ data?: TransactionsResponse; error?: ApiError }> {
    let endpoint = `/charges?limit=${Math.min(Math.max(limit, 1), 100)}`;
    if (opts?.since) {
      endpoint += `&created[gte]=${opts.since}`;
    }

    const result = await this.request<any>(endpoint);

    if (result.error) {
      return { error: result.error };
    }

    if (!result.data) {
      return {
        error: {
          message: 'Empty transactions response',
        },
      };
    }

    const charges = (result.data.data ?? []).map((c: any) => {
      const amount = c.amount === null || c.amount === undefined ? null : Number(c.amount);
      return {
        id: String(c.id || ''),
        amount,
        amount_decimal: toDecimal(amount),
        currency: String(c.currency || 'usd'),
        status: c.status ?? null,
        paid: typeof c.paid === 'boolean' ? c.paid : null,
        refunded: typeof c.refunded === 'boolean' ? c.refunded : null,
        created_at: toIso(c.created),
        description: c.description ?? null,
        receipt_email: c.receipt_email ?? null,
        customer_name: c.billing_details?.name ?? null,
      };
    });

    return {
      data: {
        transactions: charges,
        total: charges.length,
      },
    };
  }

  async getInvoices(
    limit: number = 25,
    status?: string
  ): Promise<{ data?: InvoicesResponse; error?: ApiError }> {
    let endpoint = `/invoices?limit=${Math.min(Math.max(limit, 1), 100)}`;
    if (status) {
      endpoint += `&status=${encodeURIComponent(status)}`;
    }

    const result = await this.request<any>(endpoint);

    if (result.error) {
      return { error: result.error };
    }

    if (!result.data) {
      return {
        error: {
          message: 'Empty invoices response',
        },
      };
    }

    const invoices = (result.data.data ?? []).map((i: any) => {
      const num = (v: any) => (v === null || v === undefined ? null : Number(v));
      const amount_due = num(i.amount_due);
      const amount_paid = num(i.amount_paid);
      const amount_remaining = num(i.amount_remaining);
      const total = num(i.total);
      return {
        id: String(i.id || ''),
        number: i.number ?? null,
        status: i.status ?? null,
        currency: String(i.currency || 'usd'),
        amount_due,
        amount_paid,
        amount_remaining,
        total,
        amount_due_decimal: toDecimal(amount_due),
        amount_paid_decimal: toDecimal(amount_paid),
        amount_remaining_decimal: toDecimal(amount_remaining),
        total_decimal: toDecimal(total),
        created_at: toIso(i.created),
        due_date_at: toIso(i.due_date),
        customer_email: i.customer_email ?? null,
        customer_name: i.customer_name ?? null,
        hosted_invoice_url: i.hosted_invoice_url ?? null,
      };
    });

    return {
      data: {
        invoices,
        total: invoices.length,
      },
    };
  }

  // Page charges created at/after `sinceUnix`, newest-first, up to MAX_ANALYTICS_PAGES. Returns the raw
  // charge objects plus whether the cap was hit (more charges exist in the window than were scanned).
  private async listChargesSince(
    sinceUnix: number
  ): Promise<{ charges?: any[]; capped?: boolean; error?: ApiError }> {
    const charges: any[] = [];
    let startingAfter: string | undefined;
    let capped = false;
    for (let page = 0; page < MAX_ANALYTICS_PAGES; page++) {
      let endpoint = `/charges?limit=100&created[gte]=${sinceUnix}`;
      if (startingAfter) endpoint += `&starting_after=${encodeURIComponent(startingAfter)}`;
      const result = await this.request<any>(endpoint);
      if (result.error) return { error: result.error };
      const batch: any[] = result.data?.data ?? [];
      charges.push(...batch);
      if (result.data?.has_more && batch.length > 0) {
        startingAfter = String(batch[batch.length - 1]?.id ?? '');
        if (!startingAfter) break;
        if (page === MAX_ANALYTICS_PAGES - 1) capped = true;
      } else {
        break;
      }
    }
    return { charges, capped };
  }

  async getAnalytics(
    sinceDays: number = 30
  ): Promise<{ data?: AnalyticsSummary; error?: ApiError }> {
    const since = Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60;
    const { charges, capped, error } = await this.listChargesSince(since);
    if (error) return { error };

    const byCurrency = new Map<string, CurrencyAnalytics>();

    for (const c of charges ?? []) {
      const currency = String(c.currency || 'usd');
      const amount = Number(c.amount) || 0;
      const amountRefunded = Number(c.amount_refunded) || 0;
      const refunded = c.refunded === true || amountRefunded > 0;
      const succeeded = c.status === 'succeeded';

      let entry = byCurrency.get(currency);
      if (!entry) {
        entry = {
          currency,
          gross: 0,
          net: 0,
          gross_decimal: 0,
          net_decimal: 0,
          count: 0,
          succeeded_count: 0,
          refunded_count: 0,
          avg_transaction: 0,
          avg_transaction_decimal: 0,
          refund_rate: 0,
        };
        byCurrency.set(currency, entry);
      }

      entry.count += 1;
      entry.gross += amount;
      entry.net += amount - amountRefunded;
      if (succeeded) entry.succeeded_count += 1;
      if (refunded) entry.refunded_count += 1;
    }

    // Derive the per-currency ratios + decimal conveniences once the sums are final.
    for (const entry of byCurrency.values()) {
      entry.gross_decimal = round2(entry.gross / 100);
      entry.net_decimal = round2(entry.net / 100);
      entry.avg_transaction = entry.count ? Math.round(entry.gross / entry.count) : 0;
      entry.avg_transaction_decimal = round2(entry.avg_transaction / 100);
      entry.refund_rate = entry.count ? round2(entry.refunded_count / entry.count) : 0;
    }

    return {
      data: {
        since_at: new Date(since * 1000).toISOString(),
        charge_count: (charges ?? []).length,
        capped: capped === true,
        currencies: Array.from(byCurrency.values()),
      },
    };
  }

  async getRevenueTimeseries(opts: {
    sinceDays?: number;
    interval?: 'day' | 'week' | 'month';
  }): Promise<{ data?: RevenueTimeseries; error?: ApiError }> {
    const sinceDays = Math.min(Math.max(opts.sinceDays ?? 30, 1), 365);
    const interval = opts.interval ?? 'day';
    const since = Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60;
    const { charges, capped, error } = await this.listChargesSince(since);
    if (error) return { error };

    // Bucket by (period, currency) so multi-currency accounts stay separable.
    const buckets = new Map<string, TimeseriesBucket>();
    for (const c of charges ?? []) {
      const created = Number(c.created);
      if (!Number.isFinite(created)) continue;
      const currency = String(c.currency || 'usd');
      const period = periodKey(created, interval);
      const key = `${period}|${currency}`;
      const amount = Number(c.amount) || 0;
      const amountRefunded = Number(c.amount_refunded) || 0;
      let b = buckets.get(key);
      if (!b) {
        b = { period, currency, gross: 0, net: 0, gross_decimal: 0, net_decimal: 0, count: 0 };
        buckets.set(key, b);
      }
      b.count += 1;
      b.gross += amount;
      b.net += amount - amountRefunded;
    }
    const list = Array.from(buckets.values())
      .map((b) => ({ ...b, gross_decimal: round2(b.gross / 100), net_decimal: round2(b.net / 100) }))
      .sort((a, z) => (a.period < z.period ? -1 : a.period > z.period ? 1 : a.currency < z.currency ? -1 : 1));

    return {
      data: {
        interval,
        since_at: new Date(since * 1000).toISOString(),
        capped: capped === true,
        buckets: list,
      },
    };
  }
}

export async function createClient(ctx: ToolContext): Promise<{
  client?: StripeClient;
  error?: ApiError;
}> {
  try {
    const apiKey = await secretRequired(ctx, 'STRIPE_API_KEY');
    return { client: new StripeClient(ctx, apiKey) };
  } catch (exc) {
    return {
      error: {
        message: `Failed to initialize Stripe client: ${exc instanceof Error ? exc.message : 'Unknown'}`,
      },
    };
  }
}
