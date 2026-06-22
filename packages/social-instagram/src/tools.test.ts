// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeInstagramTools } from './tools.js';

test('makeInstagramTools returns array with 3 tools', () => {
  const tools = makeInstagramTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeInstagramTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['instagram_post', 'instagram_profile', 'instagram_search']);
});
