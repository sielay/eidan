// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { ThreadsClient } from './client.js';

test('ThreadsClient is defined', () => {
  assert(typeof ThreadsClient === 'function');
});
