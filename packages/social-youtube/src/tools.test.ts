// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeYouTubeTools } from './tools.js';

test('makeYouTubeTools returns array with 3 tools', () => {
  const tools = makeYouTubeTools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeYouTubeTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['youtube_channel', 'youtube_search', 'youtube_upload']);
});
