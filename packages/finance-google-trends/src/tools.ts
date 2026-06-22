// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { GoogleTrendsClient } from './client.js';

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search term or topic.' },
    timeframe: {
      type: 'string',
      description: 'Timeframe (default: now 1-m). Examples: now 1-d, now 7-d, now 30-d, now 90-d, now 12-m, 2020-01-01 2020-12-31',
    },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
  },
};

const TOPICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max topics (default 10).' },
  },
};

const RISING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search term to find rising queries for.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max queries (default 10).' },
  },
};

export function makeGoogleTrendsTools(): Tool[] {
  const searchTrendsTool: Tool = {
    name: 'google_trends_search',
    description:
      'Search Google Trends for search term interest over time. Requires GOOGLE_TRENDS_API_KEY vault secret.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; timeframe?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new GoogleTrendsClient(ctx);
        const result = await client.searchTrends(query, args.timeframe || 'now 1-m', Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              trends: result.trends,
              count: result.trends.length,
            },
          };
        }
      },
    },
  };

  const topicsTool: Tool = {
    name: 'google_trends_topics',
    description: 'Get current trending topics on Google Trends.',
    inputSchema: TOPICS_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number };
        const client = new GoogleTrendsClient(ctx);
        const result = await client.getTopics('', Number(args.limit) || 10);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              topics: result.topics,
              count: result.topics.length,
            },
          };
        }
      },
    },
  };

  const risingTool: Tool = {
    name: 'google_trends_rising',
    description: 'Get rising queries related to a search term on Google Trends.',
    inputSchema: RISING_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = new GoogleTrendsClient(ctx);
        const result = await client.getRisingQueries(query, Number(args.limit) || 10);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              rising_queries: result.queries,
              count: result.queries.length,
            },
          };
        }
      },
    },
  };

  return [searchTrendsTool, topicsTool, risingTool];
}
