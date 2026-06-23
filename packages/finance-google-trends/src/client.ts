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
  private maxRetries = 3;
  private initialBackoffMs = 1000;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  private async fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, options);
        // Don't retry on success or client errors (4xx) except rate limiting (429)
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
          return res;
        }
        // Retry on rate limiting (429), service unavailable (503), and server errors (5xx)
        if (res.status === 429 || res.status === 503 || res.status >= 500) {
          if (attempt < this.maxRetries) {
            const backoffMs = this.initialBackoffMs * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
        }
        return res;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          const backoffMs = this.initialBackoffMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
    throw lastError || new Error('Fetch failed after retries');
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
        category: cat,
      };

      const res = await this.fetchWithRetry(url.toString(), {
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
            value = value.length > 0 ? value[0] : undefined;
          }
          if (typeof time === 'number' && typeof value === 'number') {
            let timestamp = time;
            // FRAGILITY WARNING: Google Trends timestamps may be in either seconds or milliseconds.
            // This heuristic assumes seconds if < 10^10 (timestamps before ~2286).
            // If Google changes timestamp format, precision, or units, this will silently produce
            // incorrect dates. Consider monitoring for sudden date shifts or implementing a
            // configurable timestamp detection strategy if Google changes their API.
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

      const res = await this.fetchWithRetry(url.toString());
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

      const rankedList: unknown[] | undefined = defaultData.rankedList;
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
              deltaMonthOverMonth = itemObj.deltaMonthOverMonth !== undefined ? itemObj.deltaMonthOverMonth : valueObj.deltaMonthOverMonth;
            }
          }

          // Only add if we have at least a title
          if (title) {
            charts.push({
              title: String(title),
              exploreUrl: exploreUrl ? String(exploreUrl) : null,
              deltaMonthOverMonth: deltaMonthOverMonth === undefined ? undefined : Number(deltaMonthOverMonth),
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
      url.searchParams.append('type', 'RISING');

      const res = await this.fetchWithRetry(url.toString());
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

      const rankedList: unknown[] | undefined = defaultData.rankedList;
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
              // value may be missing in API response; if absent, it remains undefined in the result
              // Check type explicitly to avoid NaN from Number(undefined) or non-numeric values
              const v = typeof itemObj.value === 'number' ? itemObj.value : undefined;
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

      const res = await this.fetchWithRetry(url.toString());
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
        const rankedList: unknown[] | undefined = defaultData.rankedList;
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
                // value may be missing in API response; if absent, it remains undefined in the result
                // Check type explicitly to avoid NaN from Number(undefined) or non-numeric values
                const v = typeof itemObj.value === 'number' ? itemObj.value : undefined;
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
    // Google Trends API responses may be prefixed with )]}' for JSONP security.
    // This prefix is common in Google APIs to prevent JSONP injection attacks.
    // If Google changes their response format, this may fail or return invalid JSON.
    if (text && typeof text === 'string' && text.startsWith(")]}'")) {
      return text.substring(4).trim();
    }
    return text || '';
  }

  private getHTTPErrorMessage(status: number, text?: string): string {
    // Detect common scraping issues and provide clear error messages
    if (status === 429) {
      return 'HTTP 429: Rate limited or temporarily blocked. Exponential backoff activated; retrying. If persistent, reduce request frequency or use official APIs.';
    }
    if (status === 403) {
      if (text && text.toLowerCase().includes('captcha')) {
        // CAPTCHA detected: IP is likely flagged for suspicious activity
        // The fetchWithRetry mechanism will retry with backoff, but repeated failures
        // may indicate the IP needs time to cool down before recovery is possible.
        return 'HTTP 403: CAPTCHA challenge detected. IP is likely flagged. Waiting before retry. If still failing after retries, the IP may need hours to recover; consider rotating IP or using a proxy.';
      }
      return 'HTTP 403: Access forbidden. IP may be blocked or session expired. Retrying with backoff.';
    }
    if (status === 503) {
      return 'HTTP 503: Google Trends service unavailable. Retrying with exponential backoff; try again later if persistent.';
    }
    return `HTTP ${status}: Failed to fetch data`;
  }
}
