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

      let text = await res.text();
      text = this.stripJSONPPrefix(text);

      let data: unknown;
      try {
        data = JSON.parse(text);
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

      if (typeof data !== 'object' || data === null) {
        return {
          query,
          timeframe: tf,
          geo: g,
          category: cat,
          trends: [],
          error: 'Could not parse response data: expected object',
        };
      }

      const dataObj = data as Record<string, unknown>;
      const defaultData = dataObj.default as Record<string, unknown> | undefined;
      if (!defaultData || typeof defaultData !== 'object') {
        return {
          query,
          timeframe: tf,
          geo: g,
          category: cat,
          trends: [],
          error: 'Could not parse response data: missing default object',
        };
      }

      const timelineData = defaultData.timelineData;
      if (!Array.isArray(timelineData)) {
        return {
          query,
          timeframe: tf,
          geo: g,
          category: cat,
          trends: [],
          error: 'Could not parse response data: expected timelineData array',
        };
      }

      const trends: TrendData[] = timelineData
        .map((item) => {
          const itemObj = item as Record<string, unknown>;
          const time = itemObj.time;
          const value = itemObj.value;
          if (typeof time === 'number' && typeof value === 'number') {
            return {
              date: String(time),
              value,
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

      let text = await res.text();
      text = this.stripJSONPPrefix(text);

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return {
          category: cat,
          geo: g,
          date: d,
          charts: [],
          error: 'Could not parse response data: invalid JSON',
        };
      }

      if (typeof data !== 'object' || data === null) {
        return {
          category: cat,
          geo: g,
          date: d,
          charts: [],
          error: 'Could not parse response data: expected object',
        };
      }

      const dataObj = data as Record<string, unknown>;
      const defaultData = dataObj.default as Record<string, unknown> | undefined;
      if (!defaultData || typeof defaultData !== 'object') {
        return {
          category: cat,
          geo: g,
          date: d,
          charts: [],
          error: 'Could not parse response data: missing default object',
        };
      }

      const rankedList = defaultData.rankedList;
      const charts: TopChart[] = [];

      if (Array.isArray(rankedList)) {
        for (const item of rankedList) {
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

      let text = await res.text();
      text = this.stripJSONPPrefix(text);

      let data: unknown;
      try {
        data = JSON.parse(text);
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
      const defaultData = dataObj.default as Record<string, unknown> | undefined;
      if (!defaultData || typeof defaultData !== 'object') {
        return {
          category: cat,
          geo: g,
          queries: [],
          error: 'Could not parse response data: missing default object',
        };
      }

      const rankedList = defaultData.rankedList;
      const queries: RelatedQuery[] = [];

      if (Array.isArray(rankedList)) {
        for (const rankItem of rankedList) {
          const rankObj = rankItem as Record<string, unknown>;
          const queryList = rankObj.queries;
          if (Array.isArray(queryList)) {
            for (const item of queryList) {
              const itemObj = item as Record<string, unknown>;
              queries.push({
                query: String(itemObj.query || ''),
                value: Number(itemObj.trafficPercent || 0),
              });
            }
          }
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

      let text = await res.text();
      text = this.stripJSONPPrefix(text);

      let data: unknown;
      try {
        data = JSON.parse(text);
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

      const defaultData = dataObj.default as Record<string, unknown> | undefined;
      if (defaultData && typeof defaultData === 'object') {
        const rankedList = defaultData.rankedList;
        if (Array.isArray(rankedList)) {
          for (let i = 0; i < rankedList.length; i++) {
            const rankObj = rankedList[i] as Record<string, unknown>;
            const queryList = rankObj.queries;
            if (Array.isArray(queryList)) {
              const targetList = i === 0 ? queries : topics;
              for (const item of queryList) {
                const itemObj = item as Record<string, unknown>;
                targetList.push({
                  query: String(itemObj.query || ''),
                  value: Number(itemObj.value || 0),
                });
              }
            }
          }
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

  private stripJSONPPrefix(text: string): string {
    // Google Trends API responses may be prefixed with )]}' for JSONP security
    if (text.startsWith(")]}'")) {
      return text.substring(4);
    }
    return text;
  }
}
