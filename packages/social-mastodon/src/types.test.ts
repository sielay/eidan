// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('types are exported', async () => {
  const types = await import('./types.js');
  assert.ok(types);
});
