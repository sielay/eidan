// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeXTools } from './tools.js';

test('makeXTools returns array with 3 tools', () => {
  const tools = makeXTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeXTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['x_post', 'x_profile', 'x_search']);
});
