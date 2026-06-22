# Trading 212 Plugin

Get portfolio, account, and trade data from Trading 212.

## Tools

- `trading212_portfolio()` - Get your portfolio holdings and P&L
- `trading212_account()` - Get your account balance and equity
- `trading212_trades(limit?)` - Get recent trades and transaction history

## Setup

1. Create a Trading 212 account
2. Generate API key at https://www.trading212.com/api/docs
3. Store in vault:
   - `TRADING212_API_KEY` - Your API key

## Example

```
Portfolio: Get holdings and P&L
Account: Check balance
Trades: Last 100 trades
```

## Troubleshooting

- **Authentication failed**: Check TRADING212_API_KEY is valid
- **API limit exceeded**: Trading 212 has rate limits
- **No data**: Ensure you have trades/holdings in your account
