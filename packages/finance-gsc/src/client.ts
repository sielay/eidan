// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { GSCResult } from './types.js';

const API_BASE = 'https://www.googleapis.com/webmasters/v3';

export class GSCClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async getPerformance(siteUrl: string, days: number = 28, limit: number = 10): Promise<GSCResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'GSC_ACCESS_TOKEN');

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const response = await fetch(`${API_BASE}/sites/searchAnalytics/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          siteUrl,
          startDate: startDate.toISOString().split('T')[0],
          endDate: new Date().toISOString().split('T')[0],
          dimensions: ['PAGE', 'QUERY', 'DATE'],
          rowLimit: limit,
          startRow: 0,
        }),
      });

      if (!response.ok) {
        return { error: `GSC API error: ${response.status}` };
      }

      const data = (await response.json()) as { rows?: Array<any> };
      return { data: data.rows || [] };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getSitemaps(siteUrl: string): Promise<GSCResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'GSC_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return { error: `GSC API error: ${response.status}` };
      }

      const data = (await response.json()) as { sitemap?: Array<any> };
      return { data: data.sitemap || [] };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getIndexingStatus(siteUrl: string): Promise<GSCResult> {
    try {
      const accessToken = await secretRequired(this.ctx, 'GSC_ACCESS_TOKEN');

      const response = await fetch(`${API_BASE}/sites/${encodeURIComponent(siteUrl)}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return { error: `GSC API error: ${response.status}` };
      }

      const data = (await response.json()) as any;
      return {
        data: {
          permissionLevel: data.permissionLevel,
          siteUrl: data.siteUrl,
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
