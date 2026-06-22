// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Position {
  instrument_id: string;
  symbol: string;
  quantity: number;
  average_price: number;
  current_price: number;
  current_value: number;
  pl_amount: number;
  pl_percentage: number;
}

export interface PortfolioResponse {
  positions: Position[];
  total_value: number;
  cash: number;
  buying_power: number;
  total_pl: number;
}

export interface Account {
  account_id: string;
  account_type: string;
  total_value: number;
  cash_balance: number;
  buying_power: number;
  currency: string;
}

export interface AccountResponse {
  account: Account;
}

export interface Trade {
  order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  executed_at: string;
  commission: number;
  status: 'FILLED' | 'CANCELLED' | 'PARTIALLY_FILLED';
}

export interface TradesResponse {
  trades: Trade[];
  total: number;
}

export interface ApiError {
  error_code?: string;
  message: string;
  status?: number;
}
