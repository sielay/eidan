// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Position {
  instrument_id: string;
  symbol: string;
  quantity: number | null;
  average_price: number | null;
  current_price: number | null;
  current_value: number | null;
  pl_amount: number | null;
  pl_percentage: number | null;
}

export interface PortfolioResponse {
  positions: Position[];
  total_value: number | null;
  cash: number | null;
  buying_power: number | null;
  total_pl: number | null;
}

export interface Account {
  account_id: string;
  account_type: string;
  total_value: number | null;
  cash_balance: number | null;
  buying_power: number | null;
  currency: string;
}

export interface AccountResponse {
  account: Account;
}

export interface Trade {
  order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number | null;
  price: number | null;
  executed_at: string;
  commission: number | null;
  status: 'FILLED' | 'CANCELLED' | 'PARTIALLY_FILLED';
}

export interface TradesResponse {
  trades: Trade[];
  total: number | null;
}

export interface ApiError {
  error_code?: string;
  message: string;
  status?: number;
}
