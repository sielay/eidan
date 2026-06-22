// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { LinkedInClient } from './client.js';

test('LinkedInClient is defined', () => {
  assert(typeof LinkedInClient === 'function');
});
