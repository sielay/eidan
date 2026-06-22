// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeGSCTools } from './tools.js';

test('makeGSCTools returns array with 3 tools', () => {
  const tools = makeGSCTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeGSCTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['gsc_indexing', 'gsc_performance', 'gsc_sitemaps']);
});
