// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { XeroClient, parseXeroDate, flattenReport } from './client.js';

type FetchArgs = { url: string; init: RequestInit | undefined };
let calls: FetchArgs[] = [];
const realFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('parseXeroDate', () => {
  it('parses the Microsoft /Date(ms)/ form', () => {
    assert.equal(parseXeroDate(undefined, '/Date(1609459200000+0000)/'), '2021-01-01T00:00:00.000Z');
  });
  it('prefers the ISO string form', () => {
    assert.equal(parseXeroDate('2021-06-15T00:00:00', '/Date(0)/'), new Date('2021-06-15T00:00:00').toISOString());
  });
  it('returns null when neither is present', () => {
    assert.equal(parseXeroDate(undefined, undefined), null);
  });
});

describe('flattenReport', () => {
  it('flattens nested sections into cell-string rows', () => {
    const report = {
      ReportName: 'Profit and Loss',
      ReportDate: '15 June 2021',
      Rows: [
        { RowType: 'Header', Cells: [{ Value: '' }, { Value: 'Jun 2021' }] },
        {
          RowType: 'Section',
          Title: 'Income',
          Rows: [{ RowType: 'Row', Cells: [{ Value: 'Sales' }, { Value: '1000.00' }] }],
        },
      ],
    };
    const flat = flattenReport(report);
    assert.equal(flat.report_name, 'Profit and Loss');
    assert.equal(flat.sections.length, 2);
    assert.deepEqual(flat.sections[1]?.rows[0]?.cells, ['Sales', '1000.00']);
  });
});

describe('XeroClient', () => {
  it('sends the Bearer token and Xero-tenant-id header', async () => {
    stubFetch(200, { Invoices: [] });
    const client = new XeroClient('tok-123', 'tenant-abc');
    await client.getInvoices({});
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer tok-123');
    assert.equal(headers['Xero-tenant-id'], 'tenant-abc');
    assert.match(calls[0]?.url ?? '', /api\.xro\/2\.0\/Invoices/);
  });

  it('projects invoices into the normalised shape', async () => {
    stubFetch(200, {
      Invoices: [
        {
          InvoiceID: 'inv-1',
          Type: 'ACCREC',
          InvoiceNumber: 'INV-001',
          Contact: { Name: 'Acme Ltd' },
          Status: 'AUTHORISED',
          DateString: '2021-01-01T00:00:00',
          DueDateString: '2021-02-01T00:00:00',
          CurrencyCode: 'GBP',
          Total: 120,
          AmountDue: 120,
          AmountPaid: 0,
        },
      ],
    });
    const client = new XeroClient('t', 'org');
    const r = await client.getInvoices({ statuses: 'AUTHORISED' });
    assert.equal(r.error, undefined);
    const inv = r.data?.[0];
    assert.equal(inv?.invoice_id, 'inv-1');
    assert.equal(inv?.contact_name, 'Acme Ltd');
    assert.equal(inv?.total, 120);
    assert.match(calls[0]?.url ?? '', /Statuses=AUTHORISED/);
  });

  it('surfaces an API error with status + body', async () => {
    stubFetch(401, 'AuthenticationUnsuccessful');
    const client = new XeroClient('bad', 'org');
    const r = await client.getAccounts();
    assert.equal(r.data, undefined);
    assert.equal(r.error?.status, 401);
    assert.match(r.error?.message ?? '', /401/);
  });

  it('errors when a report comes back empty', async () => {
    stubFetch(200, { Reports: [] });
    const client = new XeroClient('t', 'org');
    const r = await client.getBalanceSheet({});
    assert.equal(r.data, undefined);
    assert.match(r.error?.message ?? '', /no report/i);
  });

  it('ages outstanding receivables into overdue buckets with a per-contact breakdown', async () => {
    const asOf = '2023-12-01';
    stubFetch(200, {
      Invoices: [
        // overdue ~46 days -> 31-60 bucket
        { InvoiceID: 'a', Type: 'ACCREC', Contact: { Name: 'Acme' }, Status: 'AUTHORISED', DueDateString: '2023-10-16T00:00:00', CurrencyCode: 'GBP', AmountDue: 100 },
        // overdue ~16 days -> 1-30 bucket, same contact
        { InvoiceID: 'b', Type: 'ACCREC', Contact: { Name: 'Acme' }, Status: 'AUTHORISED', DueDateString: '2023-11-15T00:00:00', CurrencyCode: 'GBP', AmountDue: 50 },
        // not yet due -> current
        { InvoiceID: 'c', Type: 'ACCREC', Contact: { Name: 'Beta' }, Status: 'AUTHORISED', DueDateString: '2023-12-20T00:00:00', CurrencyCode: 'GBP', AmountDue: 200 },
        // a bill (payable) — must be ignored by receivables
        { InvoiceID: 'd', Type: 'ACCPAY', Contact: { Name: 'Supplier' }, Status: 'AUTHORISED', DueDateString: '2023-10-01T00:00:00', CurrencyCode: 'GBP', AmountDue: 999 },
        // fully paid receivable (AmountDue 0) — excluded
        { InvoiceID: 'e', Type: 'ACCREC', Contact: { Name: 'Acme' }, Status: 'AUTHORISED', DueDateString: '2023-10-01T00:00:00', CurrencyCode: 'GBP', AmountDue: 0 },
      ],
    });
    const client = new XeroClient('t', 'org');
    const r = await client.getAged('receivables', { asOf });
    assert.equal(r.error, undefined);
    const d = r.data!;
    assert.equal(d.kind, 'receivables');
    assert.equal(d.invoice_count, 3); // a, b, c (not the payable, not the paid one)
    assert.equal(d.total_outstanding, 350);
    assert.equal(d.total_overdue, 150); // a + b
    const bucket = (label: string) => d.buckets.find((b) => b.label === label)!;
    assert.equal(bucket('current').total, 200);
    assert.equal(bucket('1-30').total, 50);
    assert.equal(bucket('31-60').total, 100);
    // Sorted by outstanding desc: Beta (200, all current) ahead of Acme (150, all overdue).
    assert.equal(d.by_contact[0]?.contact_name, 'Beta');
    assert.equal(d.by_contact[0]?.outstanding, 200);
    assert.equal(d.by_contact[0]?.overdue, 0);
    const acme = d.by_contact.find((c) => c.contact_name === 'Acme')!;
    assert.equal(acme.outstanding, 150);
    assert.equal(acme.overdue, 150);
    assert.deepEqual(d.currency_codes, ['GBP']);
  });
});
