// SPDX-License-Identifier: AGPL-3.0-or-later
export interface Portfolio {
  holdings: Array<{
    ticker?: string;
    quantity?: number;
    value?: number;
    pnl?: number;
  }>;
  totalValue?: number;
  totalPnL?: number;
}

export interface Account {
  balance?: number;
  currency?: string;
  equity?: number;
  freeCapital?: number;
}

export interface Trade {
  id?: string;
  ticker?: string;
  quantity?: number;
  price?: number;
  timestamp?: string;
  type?: string;
}

export interface Trading212Result {
  data?: any;
  error?: string;
}
