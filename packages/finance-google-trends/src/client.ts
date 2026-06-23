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
// updates the API structure. Also be aware that scraping can trigger:
// - IP blocks (429 errors, slow responses)
// - CAPTCHAs (403 errors with HTML responses)
// - Rate limiting (backoff recommended)
// Consider official Google APIs (e.g., Google Search Console, Google Trends
// API via third-party wrappers) for production use.

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
        const text = await res.text().catch(() => '');
        return {
          query,
          timeframe: tf,
          geo: g,
          category: cat,
          trends: [],
          error: this.getHTTPErrorMessage(res.status, text),
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
          let value = itemObj.value;
          if (Array.isArray(value)) {
            value = value[0];
          }
          if (typeof time === 'number' && typeof value === 'number') {
            let timestamp = time;
            // Handle both seconds and milliseconds: if > 10^10, assume milliseconds
            if (timestamp < 10000000000) {
              timestamp = timestamp * 1000;
            }
            const date = new Date(timestamp);
            if (!isNaN(date.getTime())) {
              return {
                date: date.toISOString().split('T')[0],
                value,
              };
            }
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
        const text = await res.text().catch(() => '');
        return {
          category: cat,
          geo: g,
          date: d,
          charts: [],
          error: this.getHTTPErrorMessage(res.status, text),
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
          // Handle both direct fields and nested `value` structure
          let title = itemObj.title;
          let exploreUrl = itemObj.exploreUrl;
          let deltaMonthOverMonth = itemObj.deltaMonthOverMonth;

          // If title is not present, check nested value object
          if (!title || !exploreUrl) {
            const valueObj = itemObj.value as Record<string, unknown> | undefined;
            if (valueObj && typeof valueObj === 'object') {
              title = title || valueObj.title;
              exploreUrl = exploreUrl || valueObj.exploreUrl;
              deltaMonthOverMonth = deltaMonthOverMonth || valueObj.deltaMonthOverMonth;
            }
          }

          // Only add if we have at least a title
          if (title) {
            charts.push({
              title: String(title),
              exploreUrl: String(exploreUrl || ''),
              deltaMonthOverMonth: Number(deltaMonthOverMonth || 0),
            });
          }
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
        const text = await res.text().catch(() => '');
        return {
          category: cat,
          geo: g,
          queries: [],
          error: this.getHTTPErrorMessage(res.status, text),
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
          let queryList = rankObj.queries;

          // Handle case where queries might be nested in a value object
          if (!Array.isArray(queryList)) {
            const valueObj = rankObj.value as Record<string, unknown> | undefined;
            if (valueObj && typeof valueObj === 'object') {
              queryList = valueObj.queries;
            }
          }

          if (Array.isArray(queryList)) {
            for (const item of queryList) {
              const itemObj = item as Record<string, unknown>;
              const q = String(itemObj.query || itemObj.title || '');
              const v = Number(itemObj.value || 0);
              if (q) {
                queries.push({ query: q, value: v });
              }
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
        const text = await res.text().catch(() => '');
        return {
          query,
          geo: g,
          queries: [],
          topics: [],
          error: this.getHTTPErrorMessage(res.status, text),
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
          for (const rankItem of rankedList) {
            const rankObj = rankItem as Record<string, unknown>;
            // Identify whether this is a queries or topics section by looking for a `title` field
            const title = String(rankObj.title || '').toLowerCase();
            const isTopicsSection = title.includes('topic');

            let queryList = rankObj.queries;
            // Handle case where queries might be nested in a value object
            if (!Array.isArray(queryList)) {
              const valueObj = rankObj.value as Record<string, unknown> | undefined;
              if (valueObj && typeof valueObj === 'object') {
                queryList = valueObj.queries;
              }
            }

            if (Array.isArray(queryList)) {
              const targetList = isTopicsSection ? topics : queries;
              for (const item of queryList) {
                const itemObj = item as Record<string, unknown>;
                const q = String(itemObj.query || itemObj.title || '');
                const v = Number(itemObj.value || 0);
                if (q) {
                  targetList.push({ query: q, value: v });
                }
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

  private getHTTPErrorMessage(status: number, text?: string): string {
    // Detect common scraping issues and provide clear error messages
    if (status === 429) {
      return 'HTTP 429: Rate limited or temporarily blocked. Try again later or reduce request frequency.';
    }
    if (status === 403) {
      if (text && text.toLowerCase().includes('captcha')) {
        return 'HTTP 403: CAPTCHA challenge detected. IP may be temporarily blocked. Try again later.';
      }
      return 'HTTP 403: Access forbidden. IP may be blocked or session expired.';
    }
    if (status === 503) {
      return 'HTTP 503: Google Trends service unavailable. Try again later.';
    }
    return `HTTP ${status}: Failed to fetch data`;
  }
}
