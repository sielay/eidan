// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { YouTubeClient } from './client.js';

test('YouTubeClient is defined', () => {
  assert(typeof YouTubeClient === 'function');
});
