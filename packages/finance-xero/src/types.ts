// SPDX-License-Identifier: AGPL-3.0-or-later
// Normalised, snake_case shapes the tools return — a thin projection of Xero's PascalCase API so the
// agent sees stable field names and never the raw envelope.

export interface Invoice {
  invoice_id: string;
  type: string; // ACCREC (sales) | ACCPAY (bills)
  invoice_number: string;
  reference: string;
  contact_name: string;
  status: string; // DRAFT | SUBMITTED | AUTHORISED | PAID | VOIDED
  date: string | null;
  due_date: string | null;
  currency_code: string;
  sub_total: number | null;
  total_tax: number | null;
  total: number | null;
  amount_due: number | null;
  amount_paid: number | null;
}

export interface Contact {
  contact_id: string;
  name: string;
  email_address: string;
  is_customer: boolean;
  is_supplier: boolean;
  status: string;
}

export interface Account {
  account_id: string;
  code: string;
  name: string;
  type: string;
  account_class: string;
  status: string;
  tax_type: string;
  bank_account_number: string;
}

export interface BankTransaction {
  bank_transaction_id: string;
  type: string; // RECEIVE | SPEND
  contact_name: string;
  date: string | null;
  status: string;
  is_reconciled: boolean;
  total: number | null;
  currency_code: string;
  account_code: string;
}

// A flattened Xero report (P&L, balance sheet). Xero reports are deeply nested header/section/row
// trees; we flatten to sections of cell-string rows so the agent can read them without traversing.
export interface ReportRow {
  cells: string[];
}

export interface ReportSection {
  title: string;
  rows: ReportRow[];
}

export interface Report {
  report_name: string;
  report_date: string;
  sections: ReportSection[];
}

// Aged receivables/payables — outstanding amounts bucketed by how overdue they are. Computed from
// AUTHORISED invoices (amount_due > 0) rather than Xero's per-contact aged report (which needs a
// ContactID), so it works across the whole ledger in one call.
export interface AgedBucket {
  label: string; // 'current' | '1-30' | '31-60' | '61-90' | '90+'
  count: number;
  total: number;
}

export interface AgedContact {
  contact_name: string;
  outstanding: number;
  overdue: number;
  count: number;
}

export interface AgedSummary {
  kind: 'receivables' | 'payables';
  as_of: string;
  currency_codes: string[];
  invoice_count: number;
  capped: boolean;
  total_outstanding: number;
  total_overdue: number;
  buckets: AgedBucket[];
  by_contact: AgedContact[];
}

export interface ApiError {
  status?: number;
  message: string;
}
