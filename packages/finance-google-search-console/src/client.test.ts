// SPDX-License-Identifier: AGPL-3.0-or-later
import { strict as assert } from 'assert';
import { test } from 'node:test';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { GoogleSearchConsoleClient, makeGSCClient } from './client.js';

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

test('GoogleSearchConsoleClient.getPerformance returns formatted data', async () => {
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
    const ctx = { vault: {} } as unknown as ToolContext;
    const client = new GoogleSearchConsoleClient(ctx, 'https://example.com', 'token123');
    const result = await client.getPerformance(7, 10);

    assert(!result.error);
    assert(result.data);
    assert.equal(result.data?.length, 1);
    assert.equal(result.data?.[0]?.query, 'test query');
    assert.equal(result.data?.[0]?.clicks, 10);
  } finally {
    restore();
  }
});

test('GoogleSearchConsoleClient.getSitemaps returns formatted sitemaps', async () => {
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
    const ctx = { vault: {} } as unknown as ToolContext;
    const client = new GoogleSearchConsoleClient(ctx, 'https://example.com', 'token123');
    const result = await client.getSitemaps();

    assert(!result.error);
    assert(result.sitemaps);
    assert.equal(result.sitemaps?.length, 1);
    assert.equal(result.sitemaps?.[0]?.path, 'https://example.com/sitemap.xml');
  } finally {
    restore();
  }
});

test('GoogleSearchConsoleClient.getIndexingStatus returns coverage data', async () => {
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
    const ctx = { vault: {} } as unknown as ToolContext;
    const client = new GoogleSearchConsoleClient(ctx, 'https://example.com', 'token123');
    const result = await client.getIndexingStatus();

    assert(!result.error);
    assert(result.status);
    assert.equal(result.status?.indexedPages, '1000');
    assert.equal(result.status?.totalPages, '1200');
  } finally {
    restore();
  }
});

test('GoogleSearchConsoleClient.getIndexingErrors returns formatted errors', async () => {
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
    const ctx = { vault: {} } as unknown as ToolContext;
    const client = new GoogleSearchConsoleClient(ctx, 'https://example.com', 'token123');
    const result = await client.getIndexingErrors(5);

    assert(!result.error);
    assert(result.errors);
    assert.equal(result.errors?.length, 1);
    assert.equal(result.errors?.[0]?.type, 'ROBOTS_TAG');
  } finally {
    restore();
  }
});

test('makeGSCClient returns error for missing secrets', async () => {
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['GSC_ACCESS_TOKEN']);
      },
    },
  } as unknown as ToolContext;

  const result = await makeGSCClient(ctx);
  assert(result.error);
});

test('makeGSCClient creates client with valid secrets', async () => {
  const ctx = {
    vault: {
      resolve: async (key: string) => {
        if (key === '${GSC_ACCESS_TOKEN}') return 'token123';
        if (key === '${GSC_PROPERTY_URL}') return 'https://example.com';
        throw new MissingSecretError(['UNKNOWN']);
      },
    },
  } as unknown as ToolContext;

  const result = await makeGSCClient(ctx);
  assert(!result.error);
  assert(result.client);
});
