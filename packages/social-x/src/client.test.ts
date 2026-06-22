// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { XClient } from './client.js';

test('XClient is defined', () => {
  assert(typeof XClient === 'function');
});
