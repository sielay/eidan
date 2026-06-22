// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { InstagramClient } from './client.js';

test('InstagramClient is defined', () => {
  assert(typeof InstagramClient === 'function');
});
