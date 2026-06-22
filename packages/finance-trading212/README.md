# @eidandev/finance-trading212

Trading 212 Finance integration for Eidan: portfolio holdings, account information, and trade history via the Trading 212 Public API with Bearer token authentication.

## Setup

1. **Generate a Trading 212 API Key**:
   - Visit https://trading212.com/settings/api
   - Generate a new API key
   - Copy the key (keep it secret)

2. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → Trading 212 Finance):
     - **TRADING212_API_KEY**: Your API key from step 1
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       TRADING212_API_KEY: your-api-key-here
     ```

3. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/finance-trading212
   ```

4. **Restart Eidan** and verify tools are loaded:
   ```
   [finance-trading212] plugin loaded: trading212_portfolio, trading212_account, trading212_trades
   ```

## Tools

### `trading212_portfolio`

Get your current portfolio holdings with position details.

**Parameters:** None

**Example:**
```
trading212_portfolio()
```

**Returns:**
- `total_value`: Total account value
- `cash`: Available cash balance
- `buying_power`: Purchasing power
- `total_pl`: Total profit/loss
- `positions`: Array of holdings with:
  - `symbol`: Stock symbol (e.g., AAPL)
  - `quantity`: Number of shares held
  - `average_price`: Average purchase price per share
  - `current_price`: Current market price
  - `current_value`: Total position value
  - `pl_amount`: Profit/loss amount
  - `pl_percentage`: Profit/loss percentage

**Example response:**
```json
{
  "total_value": 5000,
  "cash": 1000,
  "buying_power": 5000,
  "total_pl": 250,
  "positions": [
    {
      "symbol": "AAPL",
      "quantity": 10,
      "average_price": 150,
      "current_price": 155,
      "current_value": 1550,
      "pl_amount": 50,
      "pl_percentage": 3.33
    }
  ]
}
```

### `trading212_account`

Get your account information and summary.

**Parameters:** None

**Example:**
```
trading212_account()
```

**Returns:**
- `account_id`: Account identifier
- `account_type`: Type of account (e.g., INVEST, ISA)
- `total_value`: Total account value
- `cash_balance`: Cash available in account
- `buying_power`: Total purchasing power
- `currency`: Account currency (e.g., GBP, USD)

**Example response:**
```json
{
  "account_id": "acc123",
  "account_type": "INVEST",
  "total_value": 5000,
  "cash_balance": 1000,
  "buying_power": 5000,
  "currency": "GBP"
}
```

### `trading212_trades`

Get recent trades and order history.

**Parameters:**
- `limit` (optional, 1–100): Max trades to return (default: 50)
- `symbol` (optional): Filter by stock symbol (e.g., AAPL, MSFT)

**Example:**
```
trading212_trades({ limit: 20, symbol: "AAPL" })
```

**Returns:**
- `total`: Total number of trades
- `trades`: Array of trades with:
  - `order_id`: Unique order identifier
  - `symbol`: Stock symbol
  - `side`: BUY or SELL
  - `quantity`: Number of shares
  - `price`: Execution price
  - `executed_at`: Execution timestamp (ISO 8601)
  - `commission`: Commission paid
  - `status`: FILLED, CANCELLED, or PARTIALLY_FILLED

**Example response:**
```json
{
  "total": 1,
  "trades": [
    {
      "order_id": "ord1",
      "symbol": "AAPL",
      "side": "BUY",
      "quantity": 10,
      "price": 150,
      "executed_at": "2024-06-01T10:00:00Z",
      "commission": 0,
      "status": "FILLED"
    }
  ]
}
```

## How It Works

1. **Authentication**: Uses Trading 212's Bearer token API authentication
   - Credentials stored in Eidan vault (encrypted at-rest via Fernet)
   - Never logged or exposed in errors
   - Can be rotated by generating a new API key and updating vault

2. **API**: Uses Trading 212 Public API (v0)
   - Portfolio via `/accounts/me/portfolio`
   - Account via `/accounts/me`
   - Trades via `/accounts/me/trades`

3. **Error Handling**: All errors are yielded (not thrown)
   - Network errors are caught and returned with context
   - API errors include status codes and response text
   - Missing credentials return user-friendly messages

## Troubleshooting

### "Missing secret: TRADING212_API_KEY"

Ensure the API key is set in vault:
```bash
# Via Settings UI: Connections → Trading 212 Finance
# Or set env var: TRADING212_API_KEY=your-key
```

### API returns 401 Unauthorized

Your API key may be invalid or revoked:
- Generate a new key at https://trading212.com/settings/api
- Update the vault with the new key

### "Network error" responses

Check:
- Your network connectivity
- Trading 212 API service status
- Firewall/proxy blocking api.trading212.com

### No trades returned

- Check that `symbol` parameter spelling matches Trading 212's conventions
- Use `limit` to increase results retrieved
- Ensure you have executed trades on the account

## Architecture

- **client.ts**: Trading 212 API client (HTTP requests, response parsing)
- **tools.ts**: Agent tools (portfolio, account, trades)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: Trading 212 API TypeScript definitions

## Limits

- Portfolio: Returns all current positions
- Trades: 100 results max per call
- Account: Returns single account summary
- API Key: No rate limits documented; follow Trading 212 terms

## Example Agent Usage

```
Agent: What's my current portfolio?

Agent → trading212_portfolio()

Result: {
  total_value: 5000,
  cash: 1000,
  buying_power: 5000,
  total_pl: 250,
  positions: [
    {
      symbol: "AAPL",
      quantity: 10,
      average_price: 150,
      current_price: 155,
      current_value: 1550,
      pl_amount: 50,
      pl_percentage: 3.33
    },
    {
      symbol: "MSFT",
      quantity: 5,
      average_price: 300,
      current_price: 310,
      current_value: 1550,
      pl_amount: 50,
      pl_percentage: 3.33
    }
  ]
}

Agent: Check my account balance.

Agent → trading212_account()

Result: {
  account_id: "acc123",
  account_type: "INVEST",
  total_value: 5000,
  cash_balance: 1000,
  buying_power: 5000,
  currency: "GBP"
}

Agent: Show my recent trades.

Agent → trading212_trades({ limit: 10 })

Result: {
  total: 2,
  trades: [
    {
      order_id: "ord2",
      symbol: "MSFT",
      side: "BUY",
      quantity: 5,
      price: 300,
      executed_at: "2024-06-02T14:30:00Z",
      commission: 0,
      status: "FILLED"
    },
    {
      order_id: "ord1",
      symbol: "AAPL",
      side: "BUY",
      quantity: 10,
      price: 150,
      executed_at: "2024-06-01T10:00:00Z",
      commission: 0,
      status: "FILLED"
    }
  ]
}
```

## Future Enhancements

- Order placement and cancellation
- Real-time price quotes
- Watchlist management
- Market data and charts
- Dividend and corporate action tracking
- Tax-lot reporting
- Multi-account support
