# @eidandev/finance-xero

Read-through **Xero accounting** for the agent, over OAuth2 on the shared
[`@eidandev/connections-kit`](../connections-kit). Connect one or more Xero
organisations under **Settings → Connections → Xero**; the agent can then read
your books. **Read-only** — no create/update/delete is exposed.

## Tools

| Tool | Returns |
|---|---|
| `xero_invoices` | Recent invoices (sales `ACCREC` + bills `ACCPAY`): contact, status, totals, amount due/paid, due date. Optional status filter. |
| `xero_contacts` | Contacts (customers + suppliers): name, email, customer/supplier flags. |
| `xero_accounts` | The chart of accounts: code, name, type, class, tax type, status. |
| `xero_bank_transactions` | Recent bank transactions (received/spent): contact, date, total, reconciled, bank account code. |
| `xero_profit_and_loss` | The P&L report (optional date range), flattened into titled sections of rows. |
| `xero_balance_sheet` | The Balance Sheet (optional as-at date), flattened into titled sections of rows. |

Each tool takes an optional `org` (name or slug) to pick which connected
organisation; omit it to use the first.

## How it connects

Standard authorization-code OAuth2. The operator supplies their **own** Xero
OAuth client (a *Web app* registered at developer.xero.com with the read-only
accounting scopes). On connect:

1. The web seals the client id/secret into the per-user vault (write-only path —
   it can never read them back).
2. The browser visits Xero's consent screen; Xero redirects to
   `/p/finance-xero/callback`.
3. The **engine** exchanges the code for tokens entirely server-side, discovers
   the organisation via Xero's `/connections` endpoint, and seals the rotating
   refresh token + cached 30-minute access token. The org's **tenant id** is
   stored as the account's `external_id` and replayed as the `Xero-tenant-id`
   header on every API call.

Tokens never reach the browser or a model. The kit transparently refreshes and
re-seals the (single-use, rotating) refresh token when the access token expires.

Registry rows live in `plugin_finance_xero.accounts` (created idempotently by
the kit at boot). The OAuth server listens on `MATBOT_XERO_OAUTH_PORT` (default
`8108`), proxied behind the AG-UI panel as `/api/me/finance-xero/oauth/*`.

## Scopes (read-only)

Xero's **granular** read scopes (the broad `accounting.transactions.read` /
`accounting.reports.read` are rejected unless toggled on):
`offline_access`, `accounting.contacts.read`, `accounting.settings.read`,
`accounting.invoices.read`, `accounting.banktransactions.read`,
`accounting.reports.profitandloss.read`, `accounting.reports.balancesheet.read`,
`accounting.reports.aged.read`.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — required for the account registry.
- `EIDAN_AUTH_MASTER_KEY` — required by the vault that seals the tokens.
- `MATBOT_XERO_OAUTH_PORT` — optional; OAuth server port (default `8108`).
