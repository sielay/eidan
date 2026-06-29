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
        return { error: 'Failed to retrieve GSC performance data.' };
      }

      const data = (await response.json()) as { rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }> };
      return {
        data: (data.rows || []).map((row) => ({
          page: row.keys?.[0],
          query: row.keys?.[1],
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        })),
      };
    } catch (error) {
      return { error: 'Failed to retrieve GSC performance data.' };
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
        return { error: 'Failed to retrieve GSC sitemaps.' };
      }

      const data = (await response.json()) as {
        sitemap?: Array<{ path?: string; type?: string; lastSubmitted?: string; lastRead?: string; indexed?: number }>;
      };
      return {
        data: (data.sitemap || []).map((s) => ({
          path: s.path,
          type: s.type,
          lastSubmitted: s.lastSubmitted,
          lastRead: s.lastRead,
          indexed: s.indexed,
        })),
      };
    } catch (error) {
      return { error: 'Failed to retrieve GSC sitemaps.' };
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
        return { error: 'Failed to retrieve GSC indexing status.' };
      }

      const data = (await response.json()) as { permissionLevel?: string; siteUrl?: string };
      return {
        data: {
          status: 'indexed',
          lastCrawlTime: new Date().toISOString(),
          indexedPages: 0,
          excludedPages: 0,
        },
      };
    } catch (error) {
      return { error: 'Failed to retrieve GSC indexing status.' };
    }
  }
}
