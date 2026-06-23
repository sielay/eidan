// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { SearchTrendsResult, TopicsResult, RisingQueriesResult } from './types.js';

// Note: Google Trends does not officially expose a public API. These endpoints are reverse-engineered from the web UI.
// They are subject to change without notice and may fail at any time.
// Consider using a third-party API service (SerpAPI, ValueSerps, etc.) for production use.
const API_BASE_EXPLORE = 'https://trends.google.com/trends/api/explore';
const API_BASE_DAILY = 'https://trends.google.com/trends/api/dailytrends';

export class GoogleTrendsClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async searchTrends(query: string, timeframe: string = 'now 1-m', limit: number = 20): Promise<SearchTrendsResult> {
    try {
      const apiKey = await secretRequired(this.ctx, 'GOOGLE_TRENDS_API_KEY');

      const response = await fetch(
        `${API_BASE_EXPLORE}?hl=en-US&tz=-360&req=${encodeURIComponent(JSON.stringify({
          comparisonItem: [{ keyword: query, geo: '', time: timeframe }],
          category: 0,
          property: '',
        }))}&key=${apiKey}`,
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        return { trends: [], error: `Google Trends API error: ${response.status}` };
      }

      const text = await response.text();
      const cleaned = text.replace(/^\)]}'\n/, '');
      const data = JSON.parse(cleaned) as any;

      const trends = (data.default?.timelineData || []).slice(0, limit).map((item: any) => ({
        query,
        interest: item.value?.[0],
        timestamp: new Date(parseInt(item.time) * 1000).toISOString(),
      }));

      return { trends };
    } catch (error) {
      return { trends: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getTopics(query: string, limit: number = 10): Promise<TopicsResult> {
    try {
      const apiKey = await secretRequired(this.ctx, 'GOOGLE_TRENDS_API_KEY');

      const response = await fetch(
        `${API_BASE_DAILY}?hl=en-US&tz=-360&geo=US&key=${apiKey}`,
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        return { topics: [], error: `Google Trends API error: ${response.status}` };
      }

      const text = await response.text();
      const cleaned = text.replace(/^\)]}'\n/, '');
      const data = JSON.parse(cleaned) as any;

      const topics = (data.default?.trendingSearchesDays?.[0]?.trendingSearches || [])
        .slice(0, limit)
        .map((item: any) => ({
          title: item.title?.query,
          id: item.exploreLink,
          type: 'trending',
          relevance: item.trafficPercent,
        }));

      return { topics };
    } catch (error) {
      return { topics: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getRisingQueries(query: string, limit: number = 10): Promise<RisingQueriesResult> {
    try {
      const apiKey = await secretRequired(this.ctx, 'GOOGLE_TRENDS_API_KEY');

      const response = await fetch(
        `${API_BASE_EXPLORE}?hl=en-US&tz=-360&req=${encodeURIComponent(JSON.stringify({
          comparisonItem: [{ keyword: query, geo: '', time: '' }],
          category: 0,
          property: '',
        }))}&key=${apiKey}`,
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        return { queries: [], error: `Google Trends API error: ${response.status}` };
      }

      const text = await response.text();
      const cleaned = text.replace(/^\)]}'\n/, '');
      const data = JSON.parse(cleaned) as any;

      const queries = (data.default?.relatedQueries?.[0]?.rising || [])
        .slice(0, limit)
        .map((item: any) => ({
          query: item.query,
          interest: item.value,
        }));

      return { queries };
    } catch (error) {
      return { queries: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
