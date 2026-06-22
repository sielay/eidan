// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretOpt } from './vault.js';
import type {
  SearchTrendResult,
  TopChartsResult,
  RisingQueriesResult,
  RelatedQueriesResult,
  TrendData,
  TopChart,
  RelatedQuery,
} from './types.js';

const TRENDS_BASE = 'https://trends.google.com';
const GEO_DEFAULT = '';
const CATEGORY_DEFAULT = '0';
const TIMEFRAME_MAP: Record<string, string> = {
  '1h': 'now 1-H',
  '4h': 'now 4-H',
  '1d': 'now 1-d',
  '7d': 'now 7-d',
  '30d': 'today 1-m',
  '90d': 'today 3-m',
  '1y': 'today 12-m',
  '5y': 'all',
};

export class GoogleTrendsClient {
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  async searchTrends(
    query: string,
    timeframe?: string,
    geo?: string,
    category?: string
  ): Promise<SearchTrendResult> {
    const tf = timeframe || '30d';
    const g = geo || GEO_DEFAULT;
    const cat = category || CATEGORY_DEFAULT;

    const tfParam = TIMEFRAME_MAP[tf] || TIMEFRAME_MAP['30d'];

    try {
      const url = new URL(`${TRENDS_BASE}/trends/api/dailytrends`);
      url.searchParams.append('tz', '0');
      url.searchParams.append('geo', g);

      const res = await fetch(url.toString());
      if (!res.ok) {
        return {
          query,
          timeframe: tf,
          geo: g,
          category: cat,
          trends: [],
          error: `HTTP ${res.status}: failed to fetch Google Trends`,
        };
      }

      const text = await res.text();
      const startIdx = text.indexOf('[');
      if (startIdx === -1) {
        return {
          query,
          timeframe: tf,
          geo: g,
          category: cat,
          trends: [],
          error: 'Could not parse response data',
        };
      }

      const jsonStr = text.substring(startIdx);
      const data = JSON.parse(jsonStr) as unknown;
      const dailyTrends = data as Record<string, unknown>[];

      const trends: TrendData[] = [];
      for (const day of dailyTrends) {
        const dayObj = day as Record<string, unknown>;
        const articles = (dayObj.articles as Record<string, unknown>[]) || [];

        for (const article of articles) {
          const articleObj = article as Record<string, unknown>;
          const title = String(articleObj.title || '');
          const traffic = String(articleObj.traffic || '');

          if (title.toLowerCase().includes(query.toLowerCase())) {
            const value = parseInt(traffic.replace(/[^0-9]/g, ''), 10) || 0;
            trends.push({
              date: String(dayObj.date || ''),
              value,
            });
          }
        }
      }

      return {
        query,
        timeframe: tf,
        geo: g,
        category: cat,
        trends,
      };
    } catch (exc) {
      return {
        query,
        timeframe: tf,
        geo: g,
        category: cat,
        trends: [],
        error: `Error: ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
  }

  async topCharts(category?: string, geo?: string, date?: string): Promise<TopChartsResult> {
    const cat = category || CATEGORY_DEFAULT;
    const g = geo || GEO_DEFAULT;
    const d = date || '';

    try {
      const url = new URL(`${TRENDS_BASE}/trends/api/explore`);
      url.searchParams.append('tz', '0');
      url.searchParams.append('geo', g);
      url.searchParams.append('cat', cat);
      if (d) url.searchParams.append('date', d);

      const res = await fetch(url.toString());
      if (!res.ok) {
        return {
          category: cat,
          geo: g,
          date: d,
          charts: [],
          error: `HTTP ${res.status}: failed to fetch top charts`,
        };
      }

      const text = await res.text();
      const startIdx = text.indexOf('[');
      if (startIdx === -1) {
        return {
          category: cat,
          geo: g,
          date: d,
          charts: [],
          error: 'Could not parse response data',
        };
      }

      const jsonStr = text.substring(startIdx);
      const data = JSON.parse(jsonStr) as unknown;
      const charts: TopChart[] = [];

      if (Array.isArray(data)) {
        for (const item of data) {
          const itemObj = item as Record<string, unknown>;
          charts.push({
            title: String(itemObj.title || ''),
            exploreUrl: String(itemObj.exploreUrl || ''),
            deltaMonthOverMonth: Number(itemObj.deltaMonthOverMonth || 0),
          });
        }
      }

      return {
        category: cat,
        geo: g,
        date: d,
        charts,
      };
    } catch (exc) {
      return {
        category: cat,
        geo: g,
        date: d,
        charts: [],
        error: `Error: ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
  }

  async risingQueries(category?: string, geo?: string): Promise<RisingQueriesResult> {
    const cat = category || CATEGORY_DEFAULT;
    const g = geo || GEO_DEFAULT;

    try {
      const url = new URL(`${TRENDS_BASE}/trends/api/dailytrends`);
      url.searchParams.append('tz', '0');
      url.searchParams.append('geo', g);

      const res = await fetch(url.toString());
      if (!res.ok) {
        return {
          category: cat,
          geo: g,
          queries: [],
          error: `HTTP ${res.status}: failed to fetch rising queries`,
        };
      }

      const text = await res.text();
      const startIdx = text.indexOf('[');
      if (startIdx === -1) {
        return {
          category: cat,
          geo: g,
          queries: [],
          error: 'Could not parse response data',
        };
      }

      const jsonStr = text.substring(startIdx);
      const data = JSON.parse(jsonStr) as unknown;
      const dailyTrends = data as Record<string, unknown>[];

      const queryMap = new Map<string, number>();
      for (const day of dailyTrends) {
        const dayObj = day as Record<string, unknown>;
        const articles = (dayObj.articles as Record<string, unknown>[]) || [];

        for (const article of articles) {
          const articleObj = article as Record<string, unknown>;
          const title = String(articleObj.title || '');
          const traffic = String(articleObj.traffic || '');
          const value = parseInt(traffic.replace(/[^0-9]/g, ''), 10) || 0;

          queryMap.set(title, Math.max(queryMap.get(title) || 0, value));
        }
      }

      const queries: RelatedQuery[] = Array.from(queryMap.entries())
        .map(([query, value]) => ({ query, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 50);

      return {
        category: cat,
        geo: g,
        queries,
      };
    } catch (exc) {
      return {
        category: cat,
        geo: g,
        queries: [],
        error: `Error: ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
  }

  async relatedQueries(query: string, geo?: string): Promise<RelatedQueriesResult> {
    const g = geo || GEO_DEFAULT;

    try {
      const url = new URL(`${TRENDS_BASE}/trends/api/explore`);
      url.searchParams.append('tz', '0');
      url.searchParams.append('geo', g);
      url.searchParams.append('q', query);

      const res = await fetch(url.toString());
      if (!res.ok) {
        return {
          query,
          geo: g,
          queries: [],
          topics: [],
          error: `HTTP ${res.status}: failed to fetch related queries`,
        };
      }

      const text = await res.text();
      const startIdx = text.indexOf('{');
      if (startIdx === -1) {
        return {
          query,
          geo: g,
          queries: [],
          topics: [],
          error: 'Could not parse response data',
        };
      }

      const jsonStr = text.substring(startIdx);
      const data = JSON.parse(jsonStr) as Record<string, unknown>;

      const queries: RelatedQuery[] = [];
      const topics: RelatedQuery[] = [];

      const relatedQueries = (data.relatedQueries as Record<string, unknown>[]) || [];
      for (const item of relatedQueries) {
        const itemObj = item as Record<string, unknown>;
        queries.push({
          query: String(itemObj.query || ''),
          value: Number(itemObj.value || 0),
        });
      }

      const relatedTopics = (data.relatedTopics as Record<string, unknown>[]) || [];
      for (const item of relatedTopics) {
        const itemObj = item as Record<string, unknown>;
        topics.push({
          query: String(itemObj.title || ''),
          value: Number(itemObj.value || 0),
        });
      }

      return {
        query,
        geo: g,
        queries: queries.slice(0, 20),
        topics: topics.slice(0, 20),
      };
    } catch (exc) {
      return {
        query,
        geo: g,
        queries: [],
        topics: [],
        error: `Error: ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
  }
}
