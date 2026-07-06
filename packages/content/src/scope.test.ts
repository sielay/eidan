// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseScope, scopeChain, ventureScope, channelScope, mergeBrandLayers, isChannel, CHANNELS,
} from './scope.js';

test('parseScope classifies default / venture / channel', () => {
  assert.deepEqual(parseScope(''), { kind: 'default' });
  assert.deepEqual(parseScope('default'), { kind: 'default' });
  assert.deepEqual(parseScope('venture:abc'), { kind: 'venture', ventureId: 'abc' });
  assert.deepEqual(parseScope('venture:abc:instagram'), { kind: 'channel', ventureId: 'abc', channel: 'instagram' });
});

test('parseScope falls back to default on garbage (never widens)', () => {
  assert.deepEqual(parseScope('nonsense'), { kind: 'default' });
  assert.deepEqual(parseScope('venture:'), { kind: 'default' });
});

test('scope builders round-trip', () => {
  assert.equal(ventureScope('v1'), 'venture:v1');
  assert.equal(channelScope('v1', 'x'), 'venture:v1:x');
  assert.deepEqual(parseScope(channelScope('v1', 'x')), { kind: 'channel', ventureId: 'v1', channel: 'x' });
});

test('scopeChain: default is just [default]', () => {
  assert.deepEqual(scopeChain('default', []), ['default']);
});

test('scopeChain: venture layers default then ancestry root-first', () => {
  // SIELAY (root) → Adaptive (target)
  assert.deepEqual(
    scopeChain('venture:adaptive', ['sielay', 'adaptive']),
    ['default', 'venture:sielay', 'venture:adaptive'],
  );
});

test('scopeChain: channel adds the most-specific leaf last', () => {
  assert.deepEqual(
    scopeChain('venture:adaptive:instagram', ['sielay', 'adaptive']),
    ['default', 'venture:sielay', 'venture:adaptive', 'venture:adaptive:instagram'],
  );
});

test('scopeChain: falls back to lone venture id when ancestry unknown', () => {
  assert.deepEqual(scopeChain('venture:x', []), ['default', 'venture:x']);
});

test('mergeBrandLayers: later non-empty overrides earlier, empties ignored', () => {
  const eff = mergeBrandLayers([
    { voice: 'house voice', styleguide: 'house style', language: 'British English', reference_images: [] },
    { voice: 'B2B serious', styleguide: null, language: '', reference_images: [] }, // only voice overrides
    { voice: '  ', styleguide: 'lighter, playful', language: null, reference_images: [] }, // blank voice ignored
  ]);
  assert.equal(eff.voice, 'B2B serious');
  assert.equal(eff.styleguide, 'lighter, playful');
  assert.equal(eff.language, 'British English'); // never overridden
});

test('mergeBrandLayers: reference_images accumulate as a union', () => {
  const eff = mergeBrandLayers([
    { voice: null, styleguide: null, language: null, reference_images: ['a', 'b'] },
    { voice: null, styleguide: null, language: null, reference_images: ['b', 'c'] },
  ]);
  assert.deepEqual(eff.reference_images, ['a', 'b', 'c']);
});

test('isChannel gates the allow-list', () => {
  assert.ok(isChannel('linkedin'));
  assert.ok(!isChannel('myspace'));
  assert.ok(CHANNELS.length >= 8);
});
