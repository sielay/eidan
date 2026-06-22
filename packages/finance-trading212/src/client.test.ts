// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { Trading212Client } from './client.js';

test('Trading212Client is defined', () => {
  assert(typeof Trading212Client === 'function');
});
