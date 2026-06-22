// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { GSCClient } from './client.js';

const PERFORMANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['site_url'],
  properties: {
    site_url: { type: 'string', description: 'Site URL to query (e.g., https://example.com/).' },
    days: { type: 'integer', minimum: 1, maximum: 90, description: 'Days of data (default 28).' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 10).' },
  },
};

const SITEMAPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['site_url'],
  properties: {
    site_url: { type: 'string', description: 'Site URL to query.' },
  },
};

const INDEXING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['site_url'],
  properties: {
    site_url: { type: 'string', description: 'Site URL to query.' },
  },
};

export function makeGSCTools(): Tool[] {
  const performanceTool: Tool = {
    name: 'gsc_performance',
    description:
      'Get Google Search Console performance metrics (clicks, impressions, CTR). Requires GSC_ACCESS_TOKEN vault secret.',
    inputSchema: PERFORMANCE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { site_url?: string; days?: number; limit?: number };
        const siteUrl = String(args.site_url ?? '').trim();

        if (!siteUrl) {
          yield { type: 'error', message: 'site_url is required' };
          return;
        }

        const client = new GSCClient(ctx);
        const result = await client.getPerformance(siteUrl, Number(args.days) || 28, Number(args.limit) || 10);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              site_url: siteUrl,
              metrics: result.data,
              count: Array.isArray(result.data) ? result.data.length : 0,
            },
          };
        }
      },
    },
  };

  const sitemapsTool: Tool = {
    name: 'gsc_sitemaps',
    description: 'Get Google Search Console sitemaps status and submission info.',
    inputSchema: SITEMAPS_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { site_url?: string };
        const siteUrl = String(args.site_url ?? '').trim();

        if (!siteUrl) {
          yield { type: 'error', message: 'site_url is required' };
          return;
        }

        const client = new GSCClient(ctx);
        const result = await client.getSitemaps(siteUrl);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              site_url: siteUrl,
              sitemaps: result.data,
              count: Array.isArray(result.data) ? result.data.length : 0,
            },
          };
        }
      },
    },
  };

  const indexingTool: Tool = {
    name: 'gsc_indexing',
    description: 'Get Google Search Console indexing status and coverage.',
    inputSchema: INDEXING_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { site_url?: string };
        const siteUrl = String(args.site_url ?? '').trim();

        if (!siteUrl) {
          yield { type: 'error', message: 'site_url is required' };
          return;
        }

        const client = new GSCClient(ctx);
        const result = await client.getIndexingStatus(siteUrl);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: result.data,
          };
        }
      },
    },
  };

  return [performanceTool, sitemapsTool, indexingTool];
}
