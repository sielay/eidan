// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { GoogleTrendsClient } from './client.js';

test('GoogleTrendsClient is defined', () => {
  assert(typeof GoogleTrendsClient === 'function');
});
