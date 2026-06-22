// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeLinkedInTools } from './tools.js';

test('makeLinkedInTools returns array with 3 tools', () => {
  const tools = makeLinkedInTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeLinkedInTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['linkedin_post', 'linkedin_profile', 'linkedin_search']);
});
