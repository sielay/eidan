// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { composeBrandBlock } from './brand-tool.js';
import type { BrandKit } from './db.js';

const kit = (p: Partial<BrandKit>): BrandKit => ({
  scope: 'default', voice: null, styleguide: null, language: null, reference_images: [], brand_assets: [], updated_at: new Date(0), ...p,
});

describe('composeBrandBlock', () => {
  it('is empty for null or an empty kit', () => {
    assert.strictEqual(composeBrandBlock(null), '');
    assert.strictEqual(composeBrandBlock(kit({})), '');
    assert.strictEqual(composeBrandBlock(kit({ voice: '   ' })), '');
  });

  it('includes only the fields that are set, with the header', () => {
    const out = composeBrandBlock(kit({ voice: 'warm, plain-spoken' }));
    assert.ok(out.includes('[BRAND KIT'));
    assert.ok(out.includes('Voice & tone: warm, plain-spoken'));
    assert.ok(!out.includes('Visual style'));
    assert.ok(!out.includes('Language rules'));
  });

  it('renders a full kit', () => {
    const out = composeBrandBlock(kit({ voice: 'v', styleguide: 's', language: 'l', reference_images: ['a', 'b'] }));
    assert.ok(out.includes('Voice & tone: v'));
    assert.ok(out.includes('Visual style: s'));
    assert.ok(out.includes('Language rules: l'));
    assert.ok(out.includes('Reference images: 2 attached'));
  });

  it('counts reference images', () => {
    assert.ok(composeBrandBlock(kit({ reference_images: ['x'] })).includes('1 attached'));
  });
});
