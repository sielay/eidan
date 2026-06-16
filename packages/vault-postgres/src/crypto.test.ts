// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { encryptValue, decryptValue, masterKeyConfigured } from './crypto.js';

const KEY = 'test-master-key-not-for-production-use';

describe('vault crypto (Fernet at-rest)', () => {
  before(() => { process.env['EIDAN_AUTH_MASTER_KEY'] = KEY; });

  it('masterKeyConfigured reflects the env', () => {
    const saved = process.env['EIDAN_AUTH_MASTER_KEY'];
    delete process.env['EIDAN_AUTH_MASTER_KEY'];
    assert.equal(masterKeyConfigured(), false);
    process.env['EIDAN_AUTH_MASTER_KEY'] = saved;
    assert.equal(masterKeyConfigured(), true);
  });

  it('round-trips a value (and the ciphertext is not the plaintext)', () => {
    const pt = Buffer.from('sk-secret-value-123', 'utf8');
    const ct = encryptValue(pt);
    assert.notEqual(ct.toString('utf8'), pt.toString('utf8'));
    assert.deepEqual(decryptValue(ct), pt);
  });

  it('round-trips empty, unicode, and large values', () => {
    for (const s of ['', 'hello', '🔐 unicode ✓', 'x'.repeat(5000)]) {
      const pt = Buffer.from(s, 'utf8');
      assert.deepEqual(decryptValue(encryptValue(pt)), pt, `failed for ${JSON.stringify(s.slice(0, 12))}`);
    }
  });

  it('produces a fresh token each call (random IV) yet both decrypt', () => {
    const pt = Buffer.from('same-input', 'utf8');
    const a = encryptValue(pt);
    const b = encryptValue(pt);
    assert.notEqual(a.toString('utf8'), b.toString('utf8'));
    assert.deepEqual(decryptValue(a), pt);
    assert.deepEqual(decryptValue(b), pt);
  });

  it('throws on a tampered token (HMAC mismatch)', () => {
    const ct = encryptValue(Buffer.from('secret', 'utf8'));
    const tampered = Buffer.from(ct);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => decryptValue(tampered));
  });

  it('does not decrypt under a different master key', () => {
    const ct = encryptValue(Buffer.from('secret', 'utf8'));
    process.env['EIDAN_AUTH_MASTER_KEY'] = 'a-totally-different-master-key';
    assert.throws(() => decryptValue(ct));
    process.env['EIDAN_AUTH_MASTER_KEY'] = KEY; // restore for any later specs
  });
});
