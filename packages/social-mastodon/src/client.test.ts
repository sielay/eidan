// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { MastodonClient } from './client.js';

test('MastodonClient is defined', () => {
  assert(typeof MastodonClient === 'function');
});
