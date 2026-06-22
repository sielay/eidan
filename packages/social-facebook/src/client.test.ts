// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { FacebookClient } from './client.js';

test('FacebookClient is defined', () => {
  assert(typeof FacebookClient === 'function');
});
