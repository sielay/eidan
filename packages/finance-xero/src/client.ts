// SPDX-License-Identifier: AGPL-3.0-or-later
// Thin read-only client over the Xero Accounting API (api.xro/2.0). Constructed with a freshly
// resolved access token + the connected organisation's tenant id (the kit handles minting/rotating
// the token from the vault; this client only reads). Every call carries the Bearer token and the
// `Xero-tenant-id` header. Read-only: no create/update/delete is exposed.
import type {
  Account,
  AgedBucket,
  AgedContact,
  AgedSummary,
  ApiError,
  BankTransaction,
  Contact,
  Invoice,
  Report,
  ReportSection,
} from './types.js';

const API_BASE = 'https://api.xero.com/api.xro/2.0';
// Invoices come 100 per page; we page AUTHORISED invoices up to this many pages when ageing the ledger.
const MAX_AGING_PAGES = 10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Bucket an invoice by how overdue it is at `asOf`. No due date (or not yet due) → 'current'.
function ageBucket(dueDate: string | null, asOf: number): string {
  if (!dueDate) return 'current';
  const due = Date.parse(dueDate);
  if (Number.isNaN(due)) return 'current';
  const days = Math.floor((asOf - due) / 86_400_000);
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

// Xero returns dates both as Microsoft JSON (`/Date(1609459200000+0000)/`) and, on most endpoints, as
// an ISO-ish `*String` field. Prefer the readable string; fall back to parsing the epoch form. Returns
// an ISO-8601 string, or null when neither is present/parseable.
function parseXeroDate(isoString: unknown, msDate: unknown): string | null {
  if (typeof isoString === 'string' && isoString.trim()) {
    const t = Date.parse(isoString);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
    return isoString;
  }
  if (typeof msDate === 'string') {
    const m = msDate.match(/\/Date\((-?\d+)/);
    if (m && m[1]) return new Date(Number(m[1])).toISOString();
  }
  return null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

// Flatten Xero's nested report tree (Report → Rows[Header|Section|Row] → Rows[Row → Cells[]]) into a
// list of sections, each a list of cell-string rows.
function flattenReport(report: Record<string, unknown>): Report {
  const sections: ReportSection[] = [];
  const topRows = Array.isArray(report['Rows']) ? (report['Rows'] as Record<string, unknown>[]) : [];
  for (const row of topRows) {
    const title = str(row['Title']);
    const inner = Array.isArray(row['Rows']) ? (row['Rows'] as Record<string, unknown>[]) : [];
    const rows = inner.map((r) => {
      const cells = Array.isArray(r['Cells']) ? (r['Cells'] as Record<string, unknown>[]) : [];
      return { cells: cells.map((c) => str(c['Value'])) };
    });
    // A Header row carries the column labels in its own Cells; keep it as a titled section too.
    if (rows.length === 0 && Array.isArray(row['Cells'])) {
      const cells = (row['Cells'] as Record<string, unknown>[]).map((c) => str(c['Value']));
      sections.push({ title, rows: [{ cells }] });
    } else {
      sections.push({ title, rows });
    }
  }
  return {
    report_name: str(report['ReportName'] ?? report['ReportTitle']),
    report_date: str(report['ReportDate']),
    sections,
  };
}

export class XeroClient {
  private accessToken: string;
  private tenantId: string;

  constructor(accessToken: string, tenantId: string) {
    this.accessToken = accessToken;
    this.tenantId = tenantId;
  }

  private async request<T>(path: string, query?: Record<string, string>): Promise<{ data?: T; error?: ApiError }> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Xero-tenant-id': this.tenantId,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (exc) {
      return { error: { message: `Network error: ${exc instanceof Error ? exc.message : 'unknown'}` } };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: { status: res.status, message: `Xero API error ${res.status}: ${body.slice(0, 400)}` } };
    }
    const data = (await res.json().catch(() => ({}))) as T;
    return { data };
  }

  async getInvoices(opts: { page?: number; statuses?: string }): Promise<{ data?: Invoice[]; error?: ApiError }> {
    const query: Record<string, string> = { page: String(opts.page ?? 1), order: 'Date DESC' };
    if (opts.statuses) query['Statuses'] = opts.statuses;
    const r = await this.request<{ Invoices?: Record<string, unknown>[] }>('/Invoices', query);
    if (r.error) return { error: r.error };
    const rows = r.data?.Invoices ?? [];
    return {
      data: rows.map((i) => {
        const contact = (i['Contact'] as Record<string, unknown> | undefined) ?? {};
        return {
          invoice_id: str(i['InvoiceID']),
          type: str(i['Type']),
          invoice_number: str(i['InvoiceNumber']),
          reference: str(i['Reference']),
          contact_name: str(contact['Name']),
          status: str(i['Status']),
          date: parseXeroDate(i['DateString'], i['Date']),
          due_date: parseXeroDate(i['DueDateString'], i['DueDate']),
          currency_code: str(i['CurrencyCode']),
          sub_total: num(i['SubTotal']),
          total_tax: num(i['TotalTax']),
          total: num(i['Total']),
          amount_due: num(i['AmountDue']),
          amount_paid: num(i['AmountPaid']),
        };
      }),
    };
  }

  // Aged receivables (ACCREC) or payables (ACCPAY): page AUTHORISED invoices, keep those still owing
  // (amount_due > 0) of the requested type, and bucket the outstanding amount by overdue age.
  async getAged(
    kind: 'receivables' | 'payables',
    opts: { asOf?: string },
  ): Promise<{ data?: AgedSummary; error?: ApiError }> {
    const type = kind === 'receivables' ? 'ACCREC' : 'ACCPAY';
    const asOf = opts.asOf ? Date.parse(opts.asOf) : Date.now();
    const asOfMs = Number.isNaN(asOf) ? Date.now() : asOf;

    const outstanding: Invoice[] = [];
    let capped = false;
    for (let page = 1; page <= MAX_AGING_PAGES; page++) {
      const r = await this.getInvoices({ page, statuses: 'AUTHORISED' });
      if (r.error) return { error: r.error };
      const rows = r.data ?? [];
      for (const inv of rows) {
        if (inv.type === type && (inv.amount_due ?? 0) > 0) outstanding.push(inv);
      }
      if (rows.length < 100) break;
      if (page === MAX_AGING_PAGES) capped = true;
    }

    const bucketOrder = ['current', '1-30', '31-60', '61-90', '90+'];
    const bucketTotals = new Map<string, AgedBucket>(
      bucketOrder.map((label) => [label, { label, count: 0, total: 0 }]),
    );
    const byContact = new Map<string, AgedContact>();
    const currencies = new Set<string>();
    let totalOutstanding = 0;
    let totalOverdue = 0;

    for (const inv of outstanding) {
      const due = inv.amount_due ?? 0;
      const label = ageBucket(inv.due_date, asOfMs);
      const bucket = bucketTotals.get(label)!;
      bucket.count += 1;
      bucket.total = round2(bucket.total + due);
      totalOutstanding = round2(totalOutstanding + due);
      if (label !== 'current') totalOverdue = round2(totalOverdue + due);
      if (inv.currency_code) currencies.add(inv.currency_code);

      const name = inv.contact_name || '(no contact)';
      let c = byContact.get(name);
      if (!c) {
        c = { contact_name: name, outstanding: 0, overdue: 0, count: 0 };
        byContact.set(name, c);
      }
      c.count += 1;
      c.outstanding = round2(c.outstanding + due);
      if (label !== 'current') c.overdue = round2(c.overdue + due);
    }

    return {
      data: {
        kind,
        as_of: new Date(asOfMs).toISOString(),
        currency_codes: Array.from(currencies),
        invoice_count: outstanding.length,
        capped,
        total_outstanding: totalOutstanding,
        total_overdue: totalOverdue,
        buckets: bucketOrder.map((label) => bucketTotals.get(label)!),
        by_contact: Array.from(byContact.values()).sort((a, z) => z.outstanding - a.outstanding),
      },
    };
  }

  async getContacts(opts: { page?: number }): Promise<{ data?: Contact[]; error?: ApiError }> {
    const r = await this.request<{ Contacts?: Record<string, unknown>[] }>('/Contacts', {
      page: String(opts.page ?? 1),
    });
    if (r.error) return { error: r.error };
    const rows = r.data?.Contacts ?? [];
    return {
      data: rows.map((c) => ({
        contact_id: str(c['ContactID']),
        name: str(c['Name']),
        email_address: str(c['EmailAddress']),
        is_customer: c['IsCustomer'] === true,
        is_supplier: c['IsSupplier'] === true,
        status: str(c['ContactStatus']),
      })),
    };
  }

  async getAccounts(): Promise<{ data?: Account[]; error?: ApiError }> {
    const r = await this.request<{ Accounts?: Record<string, unknown>[] }>('/Accounts');
    if (r.error) return { error: r.error };
    const rows = r.data?.Accounts ?? [];
    return {
      data: rows.map((a) => ({
        account_id: str(a['AccountID']),
        code: str(a['Code']),
        name: str(a['Name']),
        type: str(a['Type']),
        account_class: str(a['Class']),
        status: str(a['Status']),
        tax_type: str(a['TaxType']),
        bank_account_number: str(a['BankAccountNumber']),
      })),
    };
  }

  async getBankTransactions(opts: { page?: number }): Promise<{ data?: BankTransaction[]; error?: ApiError }> {
    const r = await this.request<{ BankTransactions?: Record<string, unknown>[] }>('/BankTransactions', {
      page: String(opts.page ?? 1),
    });
    if (r.error) return { error: r.error };
    const rows = r.data?.BankTransactions ?? [];
    return {
      data: rows.map((t) => {
        const contact = (t['Contact'] as Record<string, unknown> | undefined) ?? {};
        return {
          bank_transaction_id: str(t['BankTransactionID']),
          type: str(t['Type']),
          contact_name: str(contact['Name']),
          date: parseXeroDate(t['DateString'], t['Date']),
          status: str(t['Status']),
          is_reconciled: t['IsReconciled'] === true,
          total: num(t['Total']),
          currency_code: str(t['CurrencyCode']),
          account_code: str((t['BankAccount'] as Record<string, unknown> | undefined)?.['Code']),
        };
      }),
    };
  }

  async getProfitAndLoss(opts: { fromDate?: string; toDate?: string }): Promise<{ data?: Report; error?: ApiError }> {
    const query: Record<string, string> = {};
    if (opts.fromDate) query['fromDate'] = opts.fromDate;
    if (opts.toDate) query['toDate'] = opts.toDate;
    return this.report('/Reports/ProfitAndLoss', query);
  }

  async getBalanceSheet(opts: { date?: string }): Promise<{ data?: Report; error?: ApiError }> {
    const query: Record<string, string> = {};
    if (opts.date) query['date'] = opts.date;
    return this.report('/Reports/BalanceSheet', query);
  }

  private async report(path: string, query: Record<string, string>): Promise<{ data?: Report; error?: ApiError }> {
    const r = await this.request<{ Reports?: Record<string, unknown>[] }>(path, query);
    if (r.error) return { error: r.error };
    const report = r.data?.Reports?.[0];
    if (!report) return { error: { message: 'Xero returned no report data' } };
    return { data: flattenReport(report) };
  }
}

export { parseXeroDate, flattenReport };
