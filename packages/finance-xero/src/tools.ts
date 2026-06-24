// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `finance-xero` plugin — read the operator's Xero accounting data.
//
// Per-organisation OAuth on the shared connections kit: the operator connects one or more Xero orgs in
// the Connections screen. Each org's OAuth client (sealed as JSON under `client_vault_key`), the
// rotating refresh token (`refresh_vault_key`) and the cached 30-minute access token (`token_vault_key`)
// live in the vault; the registry rows live in plugin_finance_xero.accounts, with the org's tenant id
// in `external_id`. At call time the kit picks the requested org (or the first), mints/refreshes a
// short-lived access token, and the tools call the Xero API with it + the tenant header. Read-only.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { XeroClient } from './client.js';
import { xeroAdapter } from './adapter.js';

const ORG_PROP = {
  org: {
    type: 'string',
    description: 'Which connected Xero organisation (name or slug). Omit to use the first connected org.',
  },
} as const;

const NOT_CONNECTED =
  "Xero isn't connected — connect an organisation under Settings → Connections → Xero (you provide your " +
  'own Xero OAuth client; the org consent is sealed in your vault).';

// Resolve a Xero client (fresh access token + tenant id) for the selected connected org, or an error
// string. The kit transparently refreshes + re-seals an expired/rotated token under the ambient
// Principal. The tenant id comes from the account's external_id (set at connect by the adapter).
async function resolveXero(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  org: string | undefined,
): Promise<{ client?: XeroClient; error?: string }> {
  if (!store) return { error: NOT_CONNECTED };
  try {
    const { accessToken, account } = await resolveAccessToken(store, xeroAdapter, ctx, {
      ...(org ? { accountSelector: org } : {}),
      ...(seal ? { seal } : {}),
    });
    const tenantId = account.external_id;
    if (!tenantId) {
      return { error: `"${account.name}" has no Xero tenant id — reconnect it under Connections.` };
    }
    return { client: new XeroClient(accessToken, tenantId) };
  } catch (exc) {
    if (exc instanceof NotConnectedError) return { error: NOT_CONNECTED };
    if (exc instanceof AccountResolveError) return { error: exc.message };
    return { error: exc instanceof Error ? exc.message : 'failed to resolve Xero connection' };
  }
}

export function makeXeroTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const invoicesTool: Tool = {
    name: 'xero_invoices',
    description:
      'List recent Xero invoices (sales ACCREC and bills ACCPAY) with contact, status, totals, amount ' +
      'due/paid, and due date. Optionally filter by status. Read-only; requires a connected Xero organisation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED'],
          description: 'Optional: only invoices in this status.',
        },
        page: { type: 'integer', minimum: 1, description: 'Page of results (100 per page, default 1).' },
        ...ORG_PROP,
      },
    },
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { status?: string; page?: number; org?: string };
        const { client, error } = await resolveXero(ctx, store, seal, args.org);
        if (!client) return void (yield { type: 'error', message: error ?? NOT_CONNECTED });
        const r = await client.getInvoices({
          ...(args.page ? { page: Number(args.page) } : {}),
          ...(args.status ? { statuses: String(args.status) } : {}),
        });
        if (r.error) yield { type: 'error', message: r.error.message };
        else yield { type: 'result', value: { invoices: r.data ?? [] } };
      },
    },
  };

  const contactsTool: Tool = {
    name: 'xero_contacts',
    description:
      'List Xero contacts (customers + suppliers) with name, email, and whether they are a customer/supplier. ' +
      'Read-only; requires a connected Xero organisation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        page: { type: 'integer', minimum: 1, description: 'Page of results (100 per page, default 1).' },
        ...ORG_PROP,
      },
    },
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { page?: number; org?: string };
        const { client, error } = await resolveXero(ctx, store, seal, args.org);
        if (!client) return void (yield { type: 'error', message: error ?? NOT_CONNECTED });
        const r = await client.getContacts({ ...(args.page ? { page: Number(args.page) } : {}) });
        if (r.error) yield { type: 'error', message: r.error.message };
        else yield { type: 'result', value: { contacts: r.data ?? [] } };
      },
    },
  };

  const accountsTool: Tool = {
    name: 'xero_accounts',
    description:
      'List the Xero chart of accounts (code, name, type, class, tax type, status) — the ledger structure ' +
      'behind the books. Read-only; requires a connected Xero organisation.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...ORG_PROP } },
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { org?: string };
        const { client, error } = await resolveXero(ctx, store, seal, args.org);
        if (!client) return void (yield { type: 'error', message: error ?? NOT_CONNECTED });
        const r = await client.getAccounts();
        if (r.error) yield { type: 'error', message: r.error.message };
        else yield { type: 'result', value: { accounts: r.data ?? [] } };
      },
    },
  };

  const bankTxnsTool: Tool = {
    name: 'xero_bank_transactions',
    description:
      'List recent Xero bank transactions (money received/spent) with contact, date, total, reconciled ' +
      'status, and bank account code. Read-only; requires a connected Xero organisation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        page: { type: 'integer', minimum: 1, description: 'Page of results (100 per page, default 1).' },
        ...ORG_PROP,
      },
    },
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { page?: number; org?: string };
        const { client, error } = await resolveXero(ctx, store, seal, args.org);
        if (!client) return void (yield { type: 'error', message: error ?? NOT_CONNECTED });
        const r = await client.getBankTransactions({ ...(args.page ? { page: Number(args.page) } : {}) });
        if (r.error) yield { type: 'error', message: r.error.message };
        else yield { type: 'result', value: { bank_transactions: r.data ?? [] } };
      },
    },
  };

  const plTool: Tool = {
    name: 'xero_profit_and_loss',
    description:
      'Get the Xero Profit & Loss report for an optional date range (defaults to the current financial ' +
      'period), flattened into titled sections of rows. Read-only; requires a connected Xero organisation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD (optional).' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD (optional).' },
        ...ORG_PROP,
      },
    },
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { from_date?: string; to_date?: string; org?: string };
        const { client, error } = await resolveXero(ctx, store, seal, args.org);
        if (!client) return void (yield { type: 'error', message: error ?? NOT_CONNECTED });
        const r = await client.getProfitAndLoss({
          ...(args.from_date ? { fromDate: String(args.from_date) } : {}),
          ...(args.to_date ? { toDate: String(args.to_date) } : {}),
        });
        if (r.error) yield { type: 'error', message: r.error.message };
        else yield { type: 'result', value: { report: r.data } };
      },
    },
  };

  const bsTool: Tool = {
    name: 'xero_balance_sheet',
    description:
      'Get the Xero Balance Sheet report as at an optional date (defaults to today), flattened into titled ' +
      'sections of rows. Read-only; requires a connected Xero organisation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: 'As-at date YYYY-MM-DD (optional, defaults to today).' },
        ...ORG_PROP,
      },
    },
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { date?: string; org?: string };
        const { client, error } = await resolveXero(ctx, store, seal, args.org);
        if (!client) return void (yield { type: 'error', message: error ?? NOT_CONNECTED });
        const r = await client.getBalanceSheet({ ...(args.date ? { date: String(args.date) } : {}) });
        if (r.error) yield { type: 'error', message: r.error.message };
        else yield { type: 'result', value: { report: r.data } };
      },
    },
  };

  const agedReceivablesTool: Tool = {
    name: 'xero_aged_receivables',
    description:
      'Aged receivables: money owed TO the business, from outstanding sales invoices (ACCREC), bucketed by ' +
      'how overdue it is (current / 1-30 / 31-60 / 61-90 / 90+), with a per-contact breakdown and totals. ' +
      'Use to chase debtors / see cash coming in. Read-only; requires a connected Xero organisation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        as_of: { type: 'string', description: 'Age relative to this date YYYY-MM-DD (optional, defaults to today).' },
        ...ORG_PROP,
      },
    },
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { as_of?: string; org?: string };
        const { client, error } = await resolveXero(ctx, store, seal, args.org);
        if (!client) return void (yield { type: 'error', message: error ?? NOT_CONNECTED });
        const r = await client.getAged('receivables', { ...(args.as_of ? { asOf: String(args.as_of) } : {}) });
        if (r.error) yield { type: 'error', message: r.error.message };
        else yield { type: 'result', value: { aged_receivables: r.data } };
      },
    },
  };

  const agedPayablesTool: Tool = {
    name: 'xero_aged_payables',
    description:
      'Aged payables: money the business OWES, from outstanding bills (ACCPAY), bucketed by how overdue it ' +
      'is (current / 1-30 / 31-60 / 61-90 / 90+), with a per-supplier breakdown and totals. Use to plan ' +
      'cash going out. Read-only; requires a connected Xero organisation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        as_of: { type: 'string', description: 'Age relative to this date YYYY-MM-DD (optional, defaults to today).' },
        ...ORG_PROP,
      },
    },
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { as_of?: string; org?: string };
        const { client, error } = await resolveXero(ctx, store, seal, args.org);
        if (!client) return void (yield { type: 'error', message: error ?? NOT_CONNECTED });
        const r = await client.getAged('payables', { ...(args.as_of ? { asOf: String(args.as_of) } : {}) });
        if (r.error) yield { type: 'error', message: r.error.message };
        else yield { type: 'result', value: { aged_payables: r.data } };
      },
    },
  };

  return [
    invoicesTool,
    contactsTool,
    accountsTool,
    bankTxnsTool,
    plTool,
    bsTool,
    agedReceivablesTool,
    agedPayablesTool,
  ];
}
