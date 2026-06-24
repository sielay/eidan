// SPDX-License-Identifier: AGPL-3.0-or-later

export interface BalanceAmount {
  amount: number;
  amount_decimal: number;
  currency: string;
}

export interface BalanceResponse {
  available: BalanceAmount[];
  pending: BalanceAmount[];
}

export interface Transaction {
  id: string;
  amount: number | null;
  amount_decimal: number | null;
  currency: string;
  status: string | null;
  paid: boolean | null;
  refunded: boolean | null;
  created_at: string | null;
  description: string | null;
  receipt_email: string | null;
  customer_name: string | null;
}

export interface TransactionsResponse {
  transactions: Transaction[];
  total: number;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  currency: string;
  amount_due: number | null;
  amount_paid: number | null;
  amount_remaining: number | null;
  total: number | null;
  amount_due_decimal: number | null;
  amount_paid_decimal: number | null;
  amount_remaining_decimal: number | null;
  total_decimal: number | null;
  created_at: string | null;
  due_date_at: string | null;
  customer_email: string | null;
  customer_name: string | null;
  hosted_invoice_url: string | null;
}

export interface InvoicesResponse {
  invoices: Invoice[];
  total: number;
}

export interface CurrencyAnalytics {
  currency: string;
  gross: number;
  net: number;
  gross_decimal: number;
  net_decimal: number;
  count: number;
  succeeded_count: number;
  refunded_count: number;
  avg_transaction: number; // gross / count, in the smallest unit
  avg_transaction_decimal: number;
  refund_rate: number; // refunded_count / count, 0..1 (2 dp)
}

export interface AnalyticsSummary {
  since_at: string;
  charge_count: number; // total charges scanned (note if capped)
  capped: boolean; // true when the scan hit the pagination cap (older charges omitted)
  currencies: CurrencyAnalytics[];
}

export interface TimeseriesBucket {
  period: string; // YYYY-MM-DD (day/week-start) or YYYY-MM (month)
  currency: string;
  gross: number;
  net: number;
  gross_decimal: number;
  net_decimal: number;
  count: number;
}

export interface RevenueTimeseries {
  interval: 'day' | 'week' | 'month';
  since_at: string;
  capped: boolean;
  buckets: TimeseriesBucket[];
}

export interface Subscription {
  id: string;
  status: string | null; // active | trialing | past_due | canceled | …
  customer_id: string | null;
  customer_name: string | null;
  currency: string;
  mrr: number; // this subscription's monthly-recurring amount, smallest unit
  mrr_decimal: number;
  interval: string | null; // the dominant billing interval (month/year/week/day)
  quantity: number;
  current_period_end_at: string | null;
  cancel_at_period_end: boolean;
  created_at: string | null;
  items: SubscriptionItemSummary[];
}

export interface SubscriptionItemSummary {
  price_id: string | null;
  nickname: string | null;
  unit_amount: number | null;
  unit_amount_decimal: number | null;
  currency: string;
  interval: string | null;
  interval_count: number;
  quantity: number;
}

export interface CurrencyMrr {
  currency: string;
  mrr: number;
  mrr_decimal: number;
  active_count: number;
}

export interface SubscriptionsResponse {
  total: number;
  capped: boolean;
  mrr_by_currency: CurrencyMrr[];
  subscriptions: Subscription[];
}

export interface Payout {
  id: string;
  amount: number | null;
  amount_decimal: number | null;
  currency: string;
  status: string | null; // paid | pending | in_transit | canceled | failed
  type: string | null; // bank_account | card
  method: string | null; // standard | instant
  description: string | null;
  arrival_date_at: string | null;
  created_at: string | null;
}

export interface PayoutsResponse {
  payouts: Payout[];
  total: number;
}

export interface ApiError {
  error_code?: string;
  message: string;
  status?: number;
}
