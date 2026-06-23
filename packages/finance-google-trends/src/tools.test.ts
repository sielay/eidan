// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeGoogleTrendsTools } from './tools.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';

const mockContext: Partial<ToolContext> = {
  vault: {
    resolve: async () => undefined,
    writeSecret: async () => {},
    readSecret: async () => undefined,
  },
};

test('makeGoogleTrendsTools returns 4 tools', () => {
  const tools = makeGoogleTrendsTools();
  assert.equal(tools.length, 4);
});

test('makeGoogleTrendsTools creates google_trends_search tool', () => {
  const tools = makeGoogleTrendsTools();
  const searchTool = tools.find((t) => t.name === 'google_trends_search');

  assert(searchTool);
  assert.equal(searchTool.name, 'google_trends_search');
  assert(searchTool.description);
  assert(searchTool.inputSchema);
});

test('makeGoogleTrendsTools creates google_trends_top_charts tool', () => {
  const tools = makeGoogleTrendsTools();
  const tool = tools.find((t) => t.name === 'google_trends_top_charts');

  assert(tool);
  assert.equal(tool.name, 'google_trends_top_charts');
  assert(tool.description);
  assert(tool.inputSchema);
});

test('makeGoogleTrendsTools creates google_trends_rising_queries tool', () => {
  const tools = makeGoogleTrendsTools();
  const tool = tools.find((t) => t.name === 'google_trends_rising_queries');

  assert(tool);
  assert.equal(tool.name, 'google_trends_rising_queries');
  assert(tool.description);
  assert(tool.inputSchema);
});

test('makeGoogleTrendsTools creates google_trends_related tool', () => {
  const tools = makeGoogleTrendsTools();
  const tool = tools.find((t) => t.name === 'google_trends_related');

  assert(tool);
  assert.equal(tool.name, 'google_trends_related');
  assert(tool.description);
  assert(tool.inputSchema);
});

test('google_trends_search tool has correct schema', () => {
  const tools = makeGoogleTrendsTools();
  const searchTool = tools.find((t) => t.name === 'google_trends_search');

  const schema = searchTool?.inputSchema as Record<string, unknown>;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert(Array.isArray(schema.required));
  assert((schema.required as string[]).includes('query'));
});

test('google_trends_related tool validates query is required', async () => {
  const tools = makeGoogleTrendsTools();
  const relatedTool = tools.find((t) => t.name === 'google_trends_related');

  assert(relatedTool);
  const results: unknown[] = [];
  const executor = relatedTool.executor;

  for await (const result of executor.execute({}, mockContext as ToolContext)) {
    results.push(result);
  }

  assert(results.length > 0);
  const firstResult = results[0] as Record<string, unknown>;
  assert.equal(firstResult.type, 'error');
  assert(String(firstResult.message).includes('query'));
});

test('google_trends_search tool validates query is required', async () => {
  const tools = makeGoogleTrendsTools();
  const searchTool = tools.find((t) => t.name === 'google_trends_search');

  assert(searchTool);
  const results: unknown[] = [];
  const executor = searchTool.executor;

  for await (const result of executor.execute({}, mockContext as ToolContext)) {
    results.push(result);
  }

  assert(results.length > 0);
  const firstResult = results[0] as Record<string, unknown>;
  assert.equal(firstResult.type, 'error');
  assert(String(firstResult.message).includes('query'));
});
