# @eidandev/finance-stripe

Read-only Stripe Finance integration for Eidan: account balance, recent charges/transactions, invoices, and revenue analytics via the Stripe API with Bearer token authentication. This plugin never performs writes — no charges, refunds, or mutations are exposed.

## Setup

1. **Generate a Stripe API key** (a restricted, read-only key is recommended):
   - Visit https://dashboard.stripe.com/apikeys
   - Create a **restricted key** with read access to **Charges**, **Invoices**, and **Balance** (key prefix `rk_...`)
   - A full secret key (`sk_...`) also works, but a restricted read key is safer
   - Copy the key (keep it secret)

2. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → Stripe Finance):
     - **STRIPE_API_KEY**: Your API key from step 1
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       STRIPE_API_KEY: your-api-key-here
     ```

3. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/finance-stripe
   ```

4. **Restart Eidan** and verify tools are loaded:
   ```
   [finance-stripe] plugin loaded: stripe_balance, stripe_transactions, stripe_invoices, stripe_analytics
   ```

## A note on amounts

Stripe reports monetary amounts as **integers in the smallest currency unit** (e.g. cents for USD).
Every result returns the raw integer `amount` (and `amount_due` / `amount_paid` / etc.) **and** the
`currency`, plus a convenience `*_decimal` field (`amount / 100`). The currency is never hidden.
Unix timestamps (`created`, `due_date`) are converted to ISO 8601 strings in fields suffixed `_at`
(e.g. `created_at`, `due_date_at`), or `null` when absent.

## Tools

### `stripe_balance`

Get your current Stripe account balance.

**Parameters:** None

**Returns:**
- `available`: array of `{ amount, amount_decimal, currency }` (funds available for payout)
- `pending`: array of `{ amount, amount_decimal, currency }` (funds not yet available)

### `stripe_transactions`

Get recent Stripe charges/transactions.

**Parameters:**
- `limit` (optional, 1–100): Max charges to return (default: 25)
- `status` (optional): Filter by `succeeded`, `pending`, or `failed` (applied client-side)

**Returns:**
- `total`: number of charges returned (after filtering)
- `transactions`: array of `{ id, amount, amount_decimal, currency, status, paid, refunded, created_at, description, receipt_email, customer_name }`

### `stripe_invoices`

Get recent Stripe invoices.

**Parameters:**
- `limit` (optional, 1–100): Max invoices to return (default: 25)
- `status` (optional): Filter by `open`, `paid`, `draft`, `uncollectible`, or `void`

**Returns:**
- `total`: number of invoices returned
- `invoices`: array of `{ id, number, status, currency, amount_due, amount_paid, amount_remaining, total, *_decimal, created_at, due_date_at, customer_email, customer_name, hosted_invoice_url }`

### `stripe_analytics`

Get a revenue rollup over a recent window.

**Parameters:**
- `since_days` (optional, 1–365): Days back to aggregate over (default: 30)

**Returns:**
- `since_at`: ISO start of the window
- `currencies`: array of `{ currency, gross, net, count, succeeded_count, refunded_count }`
  - `gross`: sum of all charge amounts in the window
  - `net`: `gross` minus refunded amounts
  - `count`: total charges
  - `succeeded_count`: charges with status `succeeded`
  - `refunded_count`: charges that were refunded (fully or partially)

## How It Works

1. **Authentication**: Uses Stripe's Bearer token API authentication
   - Credentials stored in Eidan vault (encrypted at-rest via Fernet)
   - Never logged or exposed in errors
   - Can be rotated by generating a new API key and updating vault

2. **API**: Uses the Stripe API (`https://api.stripe.com/v1`)
   - Balance via `GET /v1/balance`
   - Transactions via `GET /v1/charges`
   - Invoices via `GET /v1/invoices`
   - Analytics aggregates `GET /v1/charges?created[gte]=...` in code

3. **Read-only**: Only GET endpoints are used. No write/charge/refund operations are exposed.

4. **Error Handling**: All errors are yielded (not thrown)
   - Network errors are caught and returned with context
   - Stripe errors surface `error.message` from the response body
   - Missing credentials return user-friendly messages

## Troubleshooting

### "Missing secret: STRIPE_API_KEY"

Ensure the API key is set in vault:
```bash
# Via Settings UI: Connections → Stripe Finance
# Or set env var: STRIPE_API_KEY=your-key
```

### API returns 401 Unauthorized

Your API key may be invalid, revoked, or lack the required read permissions:
- Create a new restricted key at https://dashboard.stripe.com/apikeys with read access to Charges, Invoices, and Balance
- Update the vault with the new key

### "Network error" responses

Check:
- Your network connectivity
- Stripe API service status
- Firewall/proxy blocking api.stripe.com

## Architecture

- **client.ts**: Stripe API client (HTTP requests, response parsing, amount/date conversion)
- **tools.ts**: Agent tools (balance, transactions, invoices, analytics)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: Stripe API TypeScript definitions

## Limits

- Transactions/Invoices: 100 results max per call
- Analytics: aggregates up to 100 charges in the window
- Read-only: no write, charge, or refund operations
