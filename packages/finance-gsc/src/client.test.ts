// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { GSCClient } from './client.js';

test('GSCClient is defined', () => {
  assert(typeof GSCClient === 'function');
});
