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

// Note: This client uses undocumented Google Trends endpoints via scraping.
// Google frequently changes its front-end structure and response formats,
// which can invalidate parsing logic. Responses may fail to parse if Google
// updates the API structure. Consider official Google APIs (e.g., Google Search
// Console, Google Trends API via third-party wrappers) for production use.

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

    try {
      const trendingTime = TIMEFRAME_MAP[tf] || TIMEFRAME_MAP['30d'];

      const url = new URL(`${TRENDS_BASE}/trends/api/widgetdata`);
      url.searchParams.append('tz', '0');

      const req = {
        comparisonItem: [
          {
            keyword: query,
            geo: g,
            time: trendingTime,
          },
        ],
        category: parseInt(cat, 10),
      };

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });

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
          error: 'Could not parse response data: no JSON array found',
        };
      }

      const jsonStr = text.substring(startIdx);
      let data: unknown;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        return {
          query,
          timeframe: tf,
          geo: g,
          category: cat,
          trends: [],
          error: 'Could not parse response data: invalid JSON',
        };
      }

      if (!Array.isArray(data)) {
        return {
          query,
          timeframe: tf,
          geo: g,
          category: cat,
          trends: [],
          error: 'Could not parse response data: expected array',
        };
      }

      const trends: TrendData[] = data
        .map((item) => {
          const arr = item as unknown[];
          if (Array.isArray(arr) && arr.length >= 2) {
            return {
              date: String(arr[0] || ''),
              value: Number(arr[1] || 0),
            };
          }
          return null;
        })
        .filter((item): item is TrendData => item !== null);

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
      const url = new URL(`${TRENDS_BASE}/trends/api/topcharts`);
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
          error: 'Could not parse response data: no JSON array found',
        };
      }

      const jsonStr = text.substring(startIdx);
      let data: unknown;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        return {
          category: cat,
          geo: g,
          date: d,
          charts: [],
          error: 'Could not parse response data: invalid JSON',
        };
      }

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
      const url = new URL(`${TRENDS_BASE}/trends/api/relatedqueries`);
      url.searchParams.append('tz', '0');
      url.searchParams.append('geo', g);
      url.searchParams.append('type', 'rising');

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
      const startIdx = text.indexOf('{');
      if (startIdx === -1) {
        return {
          category: cat,
          geo: g,
          queries: [],
          error: 'Could not parse response data: no JSON object found',
        };
      }

      const jsonStr = text.substring(startIdx);
      let data: unknown;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        return {
          category: cat,
          geo: g,
          queries: [],
          error: 'Could not parse response data: invalid JSON',
        };
      }

      if (typeof data !== 'object' || data === null) {
        return {
          category: cat,
          geo: g,
          queries: [],
          error: 'Could not parse response data: expected object',
        };
      }

      const dataObj = data as Record<string, unknown>;
      const risingQueries = dataObj.default;
      const queries: RelatedQuery[] = [];

      if (Array.isArray(risingQueries)) {
        for (const item of risingQueries) {
          const itemObj = item as Record<string, unknown>;
          queries.push({
            query: String(itemObj.query || ''),
            value: Number(itemObj.trafficPercent || 0),
          });
        }
      }

      return {
        category: cat,
        geo: g,
        queries: queries.slice(0, 50),
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
      const url = new URL(`${TRENDS_BASE}/trends/api/relatedqueries`);
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
          error: 'Could not parse response data: no JSON object found',
        };
      }

      const jsonStr = text.substring(startIdx);
      let data: unknown;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        return {
          query,
          geo: g,
          queries: [],
          topics: [],
          error: 'Could not parse response data: invalid JSON',
        };
      }

      if (typeof data !== 'object' || data === null) {
        return {
          query,
          geo: g,
          queries: [],
          topics: [],
          error: 'Could not parse response data: expected object',
        };
      }

      const dataObj = data as Record<string, unknown>;
      const queries: RelatedQuery[] = [];
      const topics: RelatedQuery[] = [];

      const topQueries = dataObj.default;
      if (Array.isArray(topQueries)) {
        for (const item of topQueries) {
          const itemObj = item as Record<string, unknown>;
          queries.push({
            query: String(itemObj.query || ''),
            value: Number(itemObj.value || 0),
          });
        }
      }

      const topTopics = dataObj.rising;
      if (Array.isArray(topTopics)) {
        for (const item of topTopics) {
          const itemObj = item as Record<string, unknown>;
          topics.push({
            query: String(itemObj.query || ''),
            value: Number(itemObj.value || 0),
          });
        }
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
