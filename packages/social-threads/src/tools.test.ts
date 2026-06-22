// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeThreadsTools } from './tools.js';

test('makeThreadsTools returns array with 3 tools', () => {
  const tools = makeThreadsTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeThreadsTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['threads_post', 'threads_profile', 'threads_search']);
});
