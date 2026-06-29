// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from './db.js';

export interface ProviderSpendInput {
  provider: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  currency?: string;
  invoiceRef?: string | null;
  source?: string | null;
  raw?: unknown;
}

export interface ProviderSpendRow {
  provider: string;
  period_start: string;
  period_end: string;
  amount: number;
  currency: string;
  invoice_ref: string | null;
  source: string | null;
}

// Actual (invoice-sourced) provider spend. One row per (user, provider, billing period) — re-parsing
// the same invoice upserts in place, so an agent can safely re-scan its mailbox without duplicating.
export class ProviderSpendStore {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async upsert(userId: string, p: ProviderSpendInput): Promise<string> {
    const { rows } = await this.db.query(
      `insert into eidan.provider_spend
         (user_id, provider, period_start, period_end, amount, currency, invoice_ref, source, raw)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (user_id, provider, period_start, period_end) where deleted_at is null
       do update set amount = excluded.amount, currency = excluded.currency,
                     invoice_ref = excluded.invoice_ref, source = excluded.source,
                     raw = excluded.raw, updated_at = now()
       returning id`,
      [
        userId, p.provider.toLowerCase().trim(), p.periodStart, p.periodEnd, p.amount,
        (p.currency ?? 'USD').toUpperCase(), p.invoiceRef ?? null, p.source ?? null,
        JSON.stringify(p.raw ?? {}),
      ],
    );
    return String(rows[0]?.id ?? '');
  }

  // Rows whose billing period overlaps [since, now]. `since` is an ISO date (YYYY-MM-DD).
  async listSince(userId: string, since: string): Promise<ProviderSpendRow[]> {
    const { rows } = await this.db.query(
      `select provider, period_start::text, period_end::text, amount::float8 as amount, currency, invoice_ref, source
       from eidan.provider_spend
       where user_id = $1 and deleted_at is null and period_end >= $2::date
       order by period_start desc, provider`,
      [userId, since],
    );
    return rows as ProviderSpendRow[];
  }
}
