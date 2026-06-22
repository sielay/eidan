// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { PortfolioResponse, AccountResponse, TradesResponse, ApiError } from './types.js';

const API_BASE = 'https://api.trading212.com/v0';

export class Trading212Client {
  private apiKey: string;
  private ctx: ToolContext;

  constructor(ctx: ToolContext, apiKey: string) {
    this.ctx = ctx;
    this.apiKey = apiKey;
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<{ data?: T; error?: ApiError }> {
    try {
      const url = `${API_BASE}${endpoint}`;
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          error: {
            status: res.status,
            message: `Trading 212 API error: ${res.status} ${errorText}`,
          },
        };
      }

      const data = (await res.json()) as T;
      return { data };
    } catch (exc) {
      return {
        error: {
          message: `Network error: ${exc instanceof Error ? exc.message : 'Unknown'}`,
        },
      };
    }
  }

  async getPortfolio(): Promise<{ data?: PortfolioResponse; error?: ApiError }> {
    const result = await this.request<PortfolioResponse>('/accounts/me/portfolio');

    if (result.error) {
      return { error: result.error };
    }

    if (!result.data) {
      return {
        error: {
          message: 'Empty portfolio response',
        },
      };
    }

    return {
      data: {
        positions: (result.data.positions ?? []).map((p: any) => ({
          instrument_id: p.instrument_id || '',
          symbol: p.symbol || 'UNKNOWN',
          quantity: Number(p.quantity) || 0,
          average_price: Number(p.average_price) || 0,
          current_price: Number(p.current_price) || 0,
          current_value: Number(p.current_value) || 0,
          pl_amount: Number(p.pl_amount) || 0,
          pl_percentage: Number(p.pl_percentage) || 0,
        })),
        total_value: Number(result.data.total_value) || 0,
        cash: Number(result.data.cash) || 0,
        buying_power: Number(result.data.buying_power) || 0,
        total_pl: Number(result.data.total_pl) || 0,
      },
    };
  }

  async getAccount(): Promise<{ data?: AccountResponse; error?: ApiError }> {
    const result = await this.request<AccountResponse>('/accounts/me');

    if (result.error) {
      return { error: result.error };
    }

    if (!result.data || !result.data.account) {
      return {
        error: {
          message: 'Empty account response',
        },
      };
    }

    return {
      data: {
        account: {
          account_id: result.data.account.account_id || '',
          account_type: result.data.account.account_type || '',
          total_value: Number(result.data.account.total_value) || 0,
          cash_balance: Number(result.data.account.cash_balance) || 0,
          buying_power: Number(result.data.account.buying_power) || 0,
          currency: result.data.account.currency || 'USD',
        },
      },
    };
  }

  async getTrades(
    limit: number = 50,
    symbol?: string
  ): Promise<{ data?: TradesResponse; error?: ApiError }> {
    let endpoint = `/accounts/me/trades?limit=${Math.min(limit, 100)}`;
    if (symbol) {
      endpoint += `&symbol=${encodeURIComponent(symbol)}`;
    }

    const result = await this.request<TradesResponse>(endpoint);

    if (result.error) {
      return { error: result.error };
    }

    if (!result.data) {
      return {
        error: {
          message: 'Empty trades response',
        },
      };
    }

    return {
      data: {
        trades: (result.data.trades ?? []).map((t: any) => ({
          order_id: t.order_id || '',
          symbol: t.symbol || 'UNKNOWN',
          side: (t.side || 'BUY') as 'BUY' | 'SELL',
          quantity: Number(t.quantity) || 0,
          price: Number(t.price) || 0,
          executed_at: t.executed_at || '',
          commission: Number(t.commission) || 0,
          status: (t.status || 'FILLED') as 'FILLED' | 'CANCELLED' | 'PARTIALLY_FILLED',
        })),
        total: Number(result.data.total) || 0,
      },
    };
  }
}

export async function createClient(ctx: ToolContext): Promise<{
  client?: Trading212Client;
  error?: ApiError;
}> {
  try {
    const apiKey = await secretRequired(ctx, 'TRADING212_API_KEY');
    return { client: new Trading212Client(ctx, apiKey) };
  } catch (exc) {
    return {
      error: {
        message: `Failed to initialize Trading 212 client: ${exc instanceof Error ? exc.message : 'Unknown'}`,
      },
    };
  }
}
