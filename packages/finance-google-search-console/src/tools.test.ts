// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
import { strict as assert } from 'assert';
import { test } from 'node:test';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeGscTools } from './tools.js';

const mockFetch = (responses: Map<string, unknown>) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const response = responses.get(urlStr);

    if (!response) {
      return new Response('Not mocked', { status: 404 });
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
};

test('gsc_performance tool executes with default params', async () => {
  const responses = new Map();
  responses.set(
    'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com/searchAnalytics/query',
    {
      rows: [
        {
          keys: ['test query', 'https://example.com/page'],
          clicks: 10,
          impressions: 100,
          ctr: 0.1,
          position: 5,
        },
      ],
    }
  );

  const restore = mockFetch(responses);
  try {
    const ctx = {
      vault: {
        resolve: async (key: string) => {
          if (key === '${GSC_ACCESS_TOKEN}') return 'token123';
          if (key === '${GSC_PROPERTY_URL}') return 'https://example.com';
          throw new MissingSecretError(['UNKNOWN']);
        },
      },
    } as unknown as ToolContext;

    const tools = makeGscTools();
    const performanceTool = tools.find((t) => t.name === 'gsc_performance');
    assert(performanceTool);

    const results: unknown[] = [];
    for await (const result of performanceTool.executor.execute(undefined, ctx)) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const resultObj = results[0] as { type: string; value?: unknown };
    assert.equal(resultObj.type, 'result');
    assert(resultObj.value);
  } finally {
    restore();
  }
});

test('gsc_performance tool validates parameter ranges', async () => {
  const ctx = {
    vault: {
      resolve: async (key: string) => {
        if (key === '${GSC_ACCESS_TOKEN}') return 'token123';
        if (key === '${GSC_PROPERTY_URL}') return 'https://example.com';
        throw new MissingSecretError(['UNKNOWN']);
      },
    },
  } as unknown as ToolContext;

  const tools = makeGscTools();
  const performanceTool = tools.find((t) => t.name === 'gsc_performance');
  assert(performanceTool);

  // days > 90 should be clamped to 90
  const schema = performanceTool.inputSchema as {
    properties: {
      days?: { maximum?: number };
      limit?: { maximum?: number };
    };
  };
  assert(schema.properties.days?.maximum === 90);
  assert(schema.properties.limit?.maximum === 100);
});

test('gsc_sitemaps tool executes', async () => {
  const responses = new Map();
  responses.set('https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com/sitemaps', {
    sitemap: [
      {
        path: 'https://example.com/sitemap.xml',
        lastSubmitted: '2026-06-20T10:00:00Z',
        type: 'sitemap',
        contents: [
          {
            indexed: '500',
          },
        ],
      },
    ],
  });

  const restore = mockFetch(responses);
  try {
    const ctx = {
      vault: {
        resolve: async (key: string) => {
          if (key === '${GSC_ACCESS_TOKEN}') return 'token123';
          if (key === '${GSC_PROPERTY_URL}') return 'https://example.com';
          throw new MissingSecretError(['UNKNOWN']);
        },
      },
    } as unknown as ToolContext;

    const tools = makeGscTools();
    const sitemapsTool = tools.find((t) => t.name === 'gsc_sitemaps');
    assert(sitemapsTool);

    const results: unknown[] = [];
    for await (const result of sitemapsTool.executor.execute({}, ctx)) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const resultObj = results[0] as { type: string };
    assert.equal(resultObj.type, 'result');
  } finally {
    restore();
  }
});

test('gsc_indexing_status tool executes', async () => {
  const responses = new Map();
  responses.set(
    'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com/inspectionIndex/coverage',
    {
      coveredPages: '1000',
      crawlablePages: '1200',
    }
  );

  const restore = mockFetch(responses);
  try {
    const ctx = {
      vault: {
        resolve: async (key: string) => {
          if (key === '${GSC_ACCESS_TOKEN}') return 'token123';
          if (key === '${GSC_PROPERTY_URL}') return 'https://example.com';
          throw new MissingSecretError(['UNKNOWN']);
        },
      },
    } as unknown as ToolContext;

    const tools = makeGscTools();
    const statusTool = tools.find((t) => t.name === 'gsc_indexing_status');
    assert(statusTool);

    const results: unknown[] = [];
    for await (const result of statusTool.executor.execute({}, ctx)) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const resultObj = results[0] as { type: string };
    assert.equal(resultObj.type, 'result');
  } finally {
    restore();
  }
});

test('gsc_indexing_errors tool executes', async () => {
  const responses = new Map();
  responses.set(
    'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com/inspectionIndex/errors',
    {
      inspectionResult: {
        crawlIssues: [
          {
            issueType: 'ROBOTS_TAG',
            severity: 'WARNING',
            details: 'Page blocked by robots.txt',
          },
        ],
      },
    }
  );

  const restore = mockFetch(responses);
  try {
    const ctx = {
      vault: {
        resolve: async (key: string) => {
          if (key === '${GSC_ACCESS_TOKEN}') return 'token123';
          if (key === '${GSC_PROPERTY_URL}') return 'https://example.com';
          throw new MissingSecretError(['UNKNOWN']);
        },
      },
    } as unknown as ToolContext;

    const tools = makeGscTools();
    const errorsTool = tools.find((t) => t.name === 'gsc_indexing_errors');
    assert(errorsTool);

    const results: unknown[] = [];
    for await (const result of errorsTool.executor.execute({ limit: 5 }, ctx)) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const resultObj = results[0] as { type: string };
    assert.equal(resultObj.type, 'result');
  } finally {
    restore();
  }
});

test('gsc tools return errors for missing secrets', async () => {
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['GSC_ACCESS_TOKEN']);
      },
    },
  } as unknown as ToolContext;

  const tools = makeGscTools();
  const performanceTool = tools[0];
  assert(performanceTool);

  const results: unknown[] = [];
  for await (const result of performanceTool.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert(results.length > 0);
  const resultObj = results[0] as { type: string };
  assert.equal(resultObj.type, 'error');
});

test('all tools have correct names and descriptions', () => {
  const tools = makeGscTools();
  const names = new Set(tools.map((t) => t.name));

  assert(names.has('gsc_performance'));
  assert(names.has('gsc_sitemaps'));
  assert(names.has('gsc_indexing_status'));
  assert(names.has('gsc_indexing_errors'));

  tools.forEach((tool) => {
    assert(tool.description);
    assert(tool.inputSchema);
    assert(tool.executor);
    assert(tool.executor.execute);
  });
});
