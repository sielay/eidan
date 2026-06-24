// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { Portfolio, Account, Trade, Trading212Result } from './types.js';

const API_BASE = 'https://api.trading212.com/v0';

export class Trading212Client {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async getPortfolio(): Promise<Trading212Result> {
    try {
      const apiKey = await secretRequired(this.ctx, 'TRADING212_API_KEY');

      const response = await fetch(`${API_BASE}/portfolio`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        return { error: 'Failed to retrieve Trading 212 portfolio data.' };
      }

      const data = (await response.json()) as Portfolio;
      return { data };
    } catch (error) {
      return { error: 'Failed to retrieve Trading 212 portfolio data.' };
    }
  }

  async getAccount(): Promise<Trading212Result> {
    try {
      const apiKey = await secretRequired(this.ctx, 'TRADING212_API_KEY');

      const response = await fetch(`${API_BASE}/account`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        return { error: 'Failed to retrieve Trading 212 account data.' };
      }

      const data = (await response.json()) as Account;
      return { data };
    } catch (error) {
      return { error: 'Failed to retrieve Trading 212 account data.' };
    }
  }

  async getTrades(limit: number = 50): Promise<Trading212Result> {
    try {
      const apiKey = await secretRequired(this.ctx, 'TRADING212_API_KEY');

      const response = await fetch(`${API_BASE}/orders?limit=${Math.min(limit, 200)}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        return { error: 'Failed to retrieve Trading 212 trade history.' };
      }

      const data = (await response.json()) as { data?: Trade[] };
      return { data: data.data };
    } catch (error) {
      return { error: 'Failed to retrieve Trading 212 trade history.' };
    }
  }
}
