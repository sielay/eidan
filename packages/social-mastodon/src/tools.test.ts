// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeMastodonTools } from './tools.js';

test('makeMastodonTools returns array with 3 tools', () => {
  const tools = makeMastodonTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeMastodonTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['mastodon_post', 'mastodon_profile', 'mastodon_search']);
});
