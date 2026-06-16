// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyHs256 } from './jwt.js';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

// Mint an HS256 token the way the web app does, so we can verify the engine's verifier.
function sign(payload: Record<string, unknown>, secret: string, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

describe('verifyHs256', () => {
  const secret = 'shared-secret';

  it('returns the claims for a valid token', () => {
    const c = verifyHs256(sign({ sub: 'user-1', email: 'a@b.c' }, secret), secret);
    assert.equal(c?.sub, 'user-1');
    assert.equal(c?.email, 'a@b.c');
  });

  it('rejects a wrong secret', () => {
    assert.equal(verifyHs256(sign({ sub: 'x' }, secret), 'other-secret'), null);
  });

  it('rejects a tampered payload (re-using the original signature)', () => {
    const original = sign({ sub: 'alice' }, secret);
    const [h, , sig] = original.split('.');
    const forged = b64url(JSON.stringify({ sub: 'admin' }));
    assert.equal(verifyHs256(`${h}.${forged}.${sig}`, secret), null);
  });

  it('rejects non-HS256 algorithms (alg-confusion guard)', () => {
    assert.equal(verifyHs256(sign({ sub: 'x' }, secret, { alg: 'none', typ: 'JWT' }), secret), null);
    assert.equal(verifyHs256(sign({ sub: 'x' }, secret, { alg: 'HS512', typ: 'JWT' }), secret), null);
  });

  it('rejects an expired token but accepts a future exp', () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(verifyHs256(sign({ sub: 'x', exp: now - 60 }, secret), secret), null);
    assert.equal(verifyHs256(sign({ sub: 'x', exp: now + 3600 }, secret), secret)?.sub, 'x');
  });

  it('accepts a token with no exp (no expiry enforced)', () => {
    assert.equal(verifyHs256(sign({ sub: 'x' }, secret), secret)?.sub, 'x');
  });

  it('rejects structurally malformed tokens', () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'a..c', '.b.c', 'a.b.', 'header!.x.y']) {
      assert.equal(verifyHs256(bad, secret), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});
