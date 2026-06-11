// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtClaims {
  sub?: string;
  exp?: number;
  [k: string]: unknown;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Minimal dependency-free HS256 JWT verify. Returns the claims if the signature is valid and the
// token isn't expired, else null. (The Next app — NextAuth or equivalent — mints the token with the
// same shared secret; the engine only verifies. Asymmetric RS256/JWKS is a later option.)
export function verifyHs256(token: string, secret: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  if (!h || !p || !sig) return null;

  let header: { alg?: string };
  try { header = JSON.parse(b64urlToBuf(h).toString('utf8')) as { alg?: string }; }
  catch { return null; }
  if (header.alg !== 'HS256') return null;

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const actual = b64urlToBuf(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let claims: JwtClaims;
  try { claims = JSON.parse(b64urlToBuf(p).toString('utf8')) as JwtClaims; }
  catch { return null; }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
  return claims;
}
