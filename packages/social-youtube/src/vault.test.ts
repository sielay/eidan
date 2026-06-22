// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { secretOpt, secretRequired } from './vault.js';

test('secretOpt and secretRequired are functions', () => {
  assert(typeof secretOpt === 'function');
  assert(typeof secretRequired === 'function');
});
