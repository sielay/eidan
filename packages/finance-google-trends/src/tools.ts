// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { GoogleTrendsClient } from './client.js';

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'Search term to track (e.g., "Bitcoin", "AI", "renewable energy").',
    },
    timeframe: {
      type: 'string',
      enum: ['1h', '4h', '1d', '7d', '30d', '90d', '1y', '5y'],
      description: 'Time period: 1h, 4h, 1d, 7d, 30d (default), 90d, 1y, or 5y.',
    },
    geo: {
      type: 'string',
      description: 'Geographic region (ISO-3166 code, e.g., "US", "GB", "IN"). Default: worldwide.',
    },
    category: {
      type: 'string',
      description: 'Trend category (e.g., "0" for all, "71" for Business & Finance). Default: 0.',
    },
  },
};

const TOP_CHARTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: {
      type: 'string',
      description: 'Trend category (e.g., "0" for all, "71" for Business & Finance). Default: 0.',
    },
    geo: {
      type: 'string',
      description: 'Geographic region (ISO-3166 code, e.g., "US", "GB", "IN"). Default: worldwide.',
    },
    date: {
      type: 'string',
      description: 'Specific date in YYYYMM format (e.g., "202406"). Default: today.',
    },
  },
};

const RISING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: {
      type: 'string',
      description: 'Trend category (e.g., "0" for all, "71" for Business & Finance). Default: 0.',
    },
    geo: {
      type: 'string',
      description: 'Geographic region (ISO-3166 code, e.g., "US", "GB"). Default: worldwide.',
    },
  },
};

const RELATED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'Search term to find related queries and topics for.',
    },
    geo: {
      type: 'string',
      description: 'Geographic region (ISO-3166 code, e.g., "US", "GB", "IN"). Default: worldwide.',
    },
  },
};

export function makeGoogleTrendsTools(): Tool[] {
  const searchTool: Tool = {
    name: 'google_trends_search',
    description:
      'Get search volume trends over time for a query. Returns trending data with dates and search interest values.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as {
          query?: string;
          timeframe?: string;
          geo?: string;
          category?: string;
        };

        const query = String(args.query ?? '').trim();
        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new GoogleTrendsClient(ctx);
        const result = await client.searchTrends(
          query,
          args.timeframe,
          args.geo,
          args.category
        );

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query: result.query,
              timeframe: result.timeframe,
              geo: result.geo || '(worldwide)',
              category: result.category,
              trend_count: result.trends.length,
              trends: result.trends.slice(0, 100),
            },
          };
        }
      },
    },
  };

  const topChartsTool: Tool = {
    name: 'google_trends_top_charts',
    description:
      'Get top trending searches by category and region. Returns top 25 trending queries with growth metrics.',
    inputSchema: TOP_CHARTS_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as {
          category?: string;
          geo?: string;
          date?: string;
        };

        const client = new GoogleTrendsClient(ctx);
        const result = await client.topCharts(args.category, args.geo, args.date);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              category: result.category,
              geo: result.geo || '(worldwide)',
              date: result.date || '(today)',
              chart_count: result.charts.length,
              charts: result.charts.map((c) => ({
                title: c.title,
                url: c.exploreUrl,
                growth_percent: c.deltaMonthOverMonth,
              })),
            },
          };
        }
      },
    },
  };

  const risingTool: Tool = {
    name: 'google_trends_rising_queries',
    description:
      'Get rising/emerging search queries with anomalies. Returns top rising searches by category and region.',
    inputSchema: RISING_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as {
          category?: string;
          geo?: string;
        };

        const client = new GoogleTrendsClient(ctx);
        const result = await client.risingQueries(args.category, args.geo);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              category: result.category,
              geo: result.geo || '(worldwide)',
              query_count: result.queries.length,
              rising_queries: result.queries.slice(0, 50).map((q) => ({
                query: q.query,
                interest_value: q.value ?? 0,
              })),
            },
          };
        }
      },
    },
  };

  const relatedTool: Tool = {
    name: 'google_trends_related',
    description:
      'Get related search queries and topics. Returns top related searches and topics for a given query.',
    inputSchema: RELATED_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as {
          query?: string;
          geo?: string;
        };

        const query = String(args.query ?? '').trim();
        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new GoogleTrendsClient(ctx);
        const result = await client.relatedQueries(query, args.geo);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query: result.query,
              geo: result.geo || '(worldwide)',
              related_queries: result.queries.map((q) => ({
                query: q.query,
                interest_value: q.value ?? 0,
              })),
              related_topics: result.topics.map((t) => ({
                topic: t.query,
                interest_value: t.value ?? 0,
              })),
            },
          };
        }
      },
    },
  };

  return [searchTool, topChartsTool, risingTool, relatedTool];
}
