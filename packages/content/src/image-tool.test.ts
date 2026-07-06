// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { b64ToBytes, normalizeParams, SIZES, QUALITIES } from './image-tool.js';

describe('b64ToBytes', () => {
  it('decodes base64 to the right bytes', () => {
    // "hi" → [104, 105]
    assert.deepStrictEqual([...b64ToBytes('aGk=')], [104, 105]);
  });
  it('round-trips a PNG signature', () => {
    // first 4 bytes of a PNG: 0x89 0x50 0x4E 0x47
    const bytes = b64ToBytes('iVBORw==');
    assert.strictEqual(bytes[0], 0x89);
    assert.strictEqual(bytes[1], 0x50);
    assert.strictEqual(bytes[2], 0x4e);
    assert.strictEqual(bytes[3], 0x47);
  });
  it('handles empty', () => {
    assert.strictEqual(b64ToBytes('').length, 0);
  });
});

describe('normalizeParams', () => {
  it('defaults sensibly', () => {
    const r = normalizeParams({});
    assert.strictEqual(r.n, 1);
    assert.strictEqual(r.size, '1024x1024');
    assert.strictEqual(r.quality, 'medium');
    assert.strictEqual(r.base, 'image');
  });
  it('clamps n to 1..4', () => {
    assert.strictEqual(normalizeParams({ n: 0 }).n, 1);
    assert.strictEqual(normalizeParams({ n: 9 }).n, 4);
    assert.strictEqual(normalizeParams({ n: 2.7 }).n, 2);
    assert.strictEqual(normalizeParams({ n: 'x' }).n, 1);
  });
  it('allow-lists size and quality, falling back to defaults', () => {
    assert.strictEqual(normalizeParams({ size: '1536x1024' }).size, '1536x1024');
    assert.strictEqual(normalizeParams({ size: '999x999' }).size, '1024x1024');
    assert.strictEqual(normalizeParams({ quality: 'high' }).quality, 'high');
    assert.strictEqual(normalizeParams({ quality: 'ultra' }).quality, 'medium');
    for (const s of SIZES) assert.strictEqual(normalizeParams({ size: s }).size, s);
    for (const q of QUALITIES) assert.strictEqual(normalizeParams({ quality: q }).quality, q);
  });
  it('sanitises the filename base', () => {
    assert.strictEqual(normalizeParams({ filename: 'My Cool Pic!!' }).base, 'My-Cool-Pic');
    assert.strictEqual(normalizeParams({ filename: '   ' }).base, 'image');
    assert.strictEqual(normalizeParams({ filename: '@@@' }).base, 'image');
  });
});
