// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GoogleTrendsClient } from './client.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';

const mockContext: Partial<ToolContext> = {
  vault: {
    resolve: async () => undefined,
    writeSecret: async () => {},
    readSecret: async () => undefined,
  },
};

test('GoogleTrendsClient.searchTrends returns result object', async () => {
  const client = new GoogleTrendsClient(mockContext as ToolContext);
  const result = await client.searchTrends('Bitcoin', '7d', 'US', '0');

  assert.equal(typeof result, 'object');
  assert.equal(result.query, 'Bitcoin');
  assert.equal(result.timeframe, '7d');
  assert.equal(result.geo, 'US');
  assert.equal(result.category, '0');
  assert(Array.isArray(result.trends));
});

test('GoogleTrendsClient.searchTrends handles missing query gracefully', async () => {
  const client = new GoogleTrendsClient(mockContext as ToolContext);
  const result = await client.searchTrends('', '7d', 'US', '0');

  assert.equal(typeof result, 'object');
  assert.equal(result.query, '');
  assert(Array.isArray(result.trends));
});

test('GoogleTrendsClient.topCharts returns result object', async () => {
  const client = new GoogleTrendsClient(mockContext as ToolContext);
  const result = await client.topCharts('0', 'US', '');

  assert.equal(typeof result, 'object');
  assert.equal(result.category, '0');
  assert.equal(result.geo, 'US');
  assert(Array.isArray(result.charts));
});

test('GoogleTrendsClient.risingQueries returns result object', async () => {
  const client = new GoogleTrendsClient(mockContext as ToolContext);
  const result = await client.risingQueries('0', 'US');

  assert.equal(typeof result, 'object');
  assert.equal(result.category, '0');
  assert.equal(result.geo, 'US');
  assert(Array.isArray(result.queries));
});

test('GoogleTrendsClient.relatedQueries returns result object', async () => {
  const client = new GoogleTrendsClient(mockContext as ToolContext);
  const result = await client.relatedQueries('Bitcoin', 'US');

  assert.equal(typeof result, 'object');
  assert.equal(result.query, 'Bitcoin');
  assert.equal(result.geo, 'US');
  assert(Array.isArray(result.queries));
  assert(Array.isArray(result.topics));
});

test('GoogleTrendsClient.searchTrends uses default timeframe', async () => {
  const client = new GoogleTrendsClient(mockContext as ToolContext);
  const result = await client.searchTrends('test');

  assert.equal(result.timeframe, '30d');
});

test('GoogleTrendsClient.searchTrends uses default geo', async () => {
  const client = new GoogleTrendsClient(mockContext as ToolContext);
  const result = await client.searchTrends('test');

  assert.equal(result.geo, '');
});
