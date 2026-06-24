// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isStale } from './stale.js';

describe('isStale', () => {
  const threshold = 60_000; // 60 seconds

  it('fresh node (just seen) is not stale', () => {
    const freshLastSeen = 1000;
    const now = 1001;
    assert.equal(isStale(freshLastSeen, now, threshold), false);
  });

  it('node past threshold is stale', () => {
    const staleLastSeen = 1000;
    const thenMs = 1000 + threshold + 1;
    assert.equal(isStale(staleLastSeen, thenMs, threshold), true);
  });

  it('node exactly at threshold boundary is not stale', () => {
    const boundaryLastSeen = 1000;
    const boundaryNow = 1000 + threshold;
    assert.equal(isStale(boundaryLastSeen, boundaryNow, threshold), false);
  });
});
