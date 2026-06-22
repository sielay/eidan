// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeGoogleTrendsTools } from './tools.js';

test('makeGoogleTrendsTools returns array with 3 tools', () => {
  const tools = makeGoogleTrendsTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeGoogleTrendsTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['google_trends_rising', 'google_trends_search', 'google_trends_topics']);
});
