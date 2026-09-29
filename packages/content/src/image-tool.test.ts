// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { b64ToBytes, normalizeParams, buildRequestBody, SIZES, QUALITIES } from './image-tool.js';

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
  it('passes any model id through, defaulting to gpt-image-1 when absent', () => {
    assert.strictEqual(normalizeParams({}).model, 'gpt-image-1');
    assert.strictEqual(normalizeParams({ model: 'dall-e-3' }).model, 'dall-e-3');
    assert.strictEqual(normalizeParams({ model: 'gpt-image-2' }).model, 'gpt-image-2'); // pass-through, no silent swap
    assert.strictEqual(normalizeParams({ model: '   ' }).model, 'gpt-image-1'); // blank → default
  });
  it('handles newer gpt-image-* models (quality mapped, size passed through)', () => {
    const b = buildRequestBody('gpt-image-2', 'x', 2, '1024x1536', 'hd');
    assert.strictEqual(b['model'], 'gpt-image-2');
    assert.strictEqual(b['size'], '1024x1536'); // newer model → size not coerced
    assert.strictEqual(b['quality'], 'high'); // hd → high for the gpt-image family
    assert.strictEqual(b['n'], 2);
    assert.strictEqual(b['response_format'], undefined); // gpt-image returns b64 natively
  });
  it('builds a model-correct request body', () => {
    const g = buildRequestBody('gpt-image-1', 'x', 2, 'auto', 'high');
    assert.strictEqual(g['model'], 'gpt-image-1');
    assert.strictEqual(g['quality'], 'high');
    assert.strictEqual(g['response_format'], undefined); // gpt-image-1 returns b64 natively
    const d3 = buildRequestBody('dall-e-3', 'x', 3, '1024x1536', 'high');
    assert.strictEqual(d3['n'], 1); // dall-e-3 is single-image
    assert.strictEqual(d3['quality'], 'hd');
    assert.strictEqual(d3['size'], '1024x1024'); // 1024x1536 invalid for dall-e-3 → corrected
    assert.strictEqual(d3['response_format'], 'b64_json');
    const d2 = buildRequestBody('dall-e-2', 'x', 2, 'auto', 'high');
    assert.strictEqual(d2['quality'], undefined); // dall-e-2 has no quality param
    assert.strictEqual(d2['size'], '1024x1024');
    assert.strictEqual(d2['response_format'], 'b64_json');
  });
  it('sanitises the filename base', () => {
    assert.strictEqual(normalizeParams({ filename: 'My Cool Pic!!' }).base, 'My-Cool-Pic');
    assert.strictEqual(normalizeParams({ filename: '   ' }).base, 'image');
    assert.strictEqual(normalizeParams({ filename: '@@@' }).base, 'image');
  });
});
