// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeFacebookTools } from './tools.js';

test('makeFacebookTools returns array with 3 tools', () => {
  const tools = makeFacebookTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeFacebookTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['facebook_post', 'facebook_profile', 'facebook_search']);
});
