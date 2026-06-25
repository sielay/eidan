// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { makeGSCClient } from './client.js';

const PERFORMANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days: {
      type: 'integer',
      minimum: 1,
      maximum: 90,
      description: 'Number of days to fetch performance data for (default: 7).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max results to return (default: 10).',
    },
  },
};

const INDEXING_ERRORS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Max errors to return (default: 5).',
    },
  },
};

export function makeGscTools(): Tool[] {
  const gscPerformanceTool: Tool = {
    name: 'gsc_performance',
    description:
      'Get Google Search Console performance data (clicks, impressions, CTR, average position) by page and query for the last N days. Requires GSC_ACCESS_TOKEN and GSC_PROPERTY_URL vault secrets.',
    inputSchema: PERFORMANCE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { days?: number; limit?: number };
        const days = Math.min(Math.max(Number(args.days) || 7, 1), 90);
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100);

        const gscResult = await makeGSCClient(ctx);
        if (gscResult.error) {
          yield { type: 'error', message: gscResult.error };
          return;
        }

        if (!gscResult.client) {
          yield { type: 'error', message: 'Failed to create GSC client' };
          return;
        }

        const result = await gscResult.client.getPerformance(days, limit);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              days,
              dataPoints: result.data?.length || 0,
              performance: result.data || [],
            },
          };
        }
      },
    },
  };

  const gscSitemapsTool: Tool = {
    name: 'gsc_sitemaps',
    description:
      'List all submitted sitemaps in Google Search Console with their status, last submission date, and indexed count. Requires GSC_ACCESS_TOKEN and GSC_PROPERTY_URL vault secrets.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    executor: {
      async *execute(input, ctx) {
        const gscResult = await makeGSCClient(ctx);
        if (gscResult.error) {
          yield { type: 'error', message: gscResult.error };
          return;
        }

        if (!gscResult.client) {
          yield { type: 'error', message: 'Failed to create GSC client' };
          return;
        }

        const result = await gscResult.client.getSitemaps();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              count: result.sitemaps?.length || 0,
              sitemaps: result.sitemaps || [],
            },
          };
        }
      },
    },
  };

  const gscIndexingStatusTool: Tool = {
    name: 'gsc_indexing_status',
    description:
      'Get the current indexing status from Google Search Console: total indexed pages, total crawlable pages, and overall coverage. Requires GSC_ACCESS_TOKEN and GSC_PROPERTY_URL vault secrets.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    executor: {
      async *execute(input, ctx) {
        const gscResult = await makeGSCClient(ctx);
        if (gscResult.error) {
          yield { type: 'error', message: gscResult.error };
          return;
        }

        if (!gscResult.client) {
          yield { type: 'error', message: 'Failed to create GSC client' };
          return;
        }

        const result = await gscResult.client.getIndexingStatus();

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              status: result.status || {
                indexedPages: '0',
                totalPages: 'unknown',
                coverage: 'Unknown',
              },
            },
          };
        }
      },
    },
  };

  const gscIndexingErrorsTool: Tool = {
    name: 'gsc_indexing_errors',
    description:
      'Get the latest indexing errors from Google Search Console: crawl errors, mobile usability issues, and AMP errors. Requires GSC_ACCESS_TOKEN and GSC_PROPERTY_URL vault secrets.',
    inputSchema: INDEXING_ERRORS_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number };
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 50);

        const gscResult = await makeGSCClient(ctx);
        if (gscResult.error) {
          yield { type: 'error', message: gscResult.error };
          return;
        }

        if (!gscResult.client) {
          yield { type: 'error', message: 'Failed to create GSC client' };
          return;
        }

        const result = await gscResult.client.getIndexingErrors(limit);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              count: result.errors?.length || 0,
              errors: result.errors || [],
            },
          };
        }
      },
    },
  };

  return [gscPerformanceTool, gscSitemapsTool, gscIndexingStatusTool, gscIndexingErrorsTool];
}
