// SPDX-License-Identifier: AGPL-3.0-or-later
// DEV-ONLY auth shim for local end-to-end testing of the Next app against the matbot engine.
// Gated by EIDAN_DEV_AUTH=1. Serves the unauthenticated /api/auth/* surface the UI expects
// (config / magic-link / verify / refresh / logout) and mints HS256 tokens the @eidandev/auth
// WebPrincipalResolver verifies with the same EIDAN_AUTH_JWT_SECRET. In production the Next app
// owns real magic-link email auth — this file is never loaded there.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Minimal HS256 signer (verify lives in @eidandev/auth; we mint here with the shared secret).
function signHs256(claims: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

// Verify a token we minted: recompute the HMAC, constant-time compare, check exp. Returns the
// claims only on a valid signature (NOT a bare base64 decode — that would accept forged tokens).
function verifyHs256(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  if (!h || !p || !sig) return null;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const actual = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>; }
  catch { return null; }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
  return claims;
}

function nowSec(): number { return Math.floor(Date.now() / 1000); }

interface DevAuthConfig { secret: string; userId: string; email: string; webOrigin: string; code: string }

function cfg(): DevAuthConfig | null {
  if (process.env['EIDAN_DEV_AUTH'] !== '1') return null;
  const secret = process.env['EIDAN_AUTH_JWT_SECRET'] ?? process.env['EIDAN_AUTH_MASTER_KEY'];
  const userId = process.env['EIDAN_DEV_USER_ID'] ?? process.env['MATBOT_PRINCIPAL'];
  if (!secret || !userId) return null;
  return {
    secret, userId,
    email: process.env['EIDAN_DEV_USER_EMAIL'] ?? 'dev@eidan.local',
    webOrigin: process.env['EIDAN_DEV_WEB_ORIGIN'] ?? 'http://localhost:3001',
    code: process.env['EIDAN_DEV_CODE'] ?? '000000',
  };
}

export function devAuthEnabled(): boolean { return cfg() !== null; }

function accessToken(c: DevAuthConfig): string {
  return signHs256({ sub: c.userId, email: c.email, typ: 'access', iat: nowSec(), exp: nowSec() + 3600 }, c.secret);
}
function refreshToken(c: DevAuthConfig): string {
  return signHs256({ sub: c.userId, email: c.email, typ: 'refresh', iat: nowSec(), exp: nowSec() + 60 * 60 * 24 * 30 }, c.secret);
}
function magicToken(c: DevAuthConfig): string {
  return signHs256({ sub: c.userId, email: c.email, typ: 'magic', iat: nowSec(), exp: nowSec() + 900 }, c.secret);
}

// Cross-origin (Next :3001 → engine :8090): the refresh cookie needs SameSite=None; Secure.
// http://localhost is a secure context, so browsers accept Secure cookies over it.
function setRefreshCookie(headers: Record<string, string>, c: DevAuthConfig): void {
  headers['set-cookie'] = `eidan_refresh=${refreshToken(c)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; HttpOnly; SameSite=None; Secure`;
}
function clearRefreshCookie(headers: Record<string, string>): void {
  headers['set-cookie'] = 'eidan_refresh=; Path=/; Max-Age=0; HttpOnly; SameSite=None; Secure';
}
function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers['cookie'];
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function send(res: ServerResponse, code: number, obj: unknown, extra: Record<string, string>, cors: Record<string, string>): void {
  res.writeHead(code, { 'content-type': 'application/json', ...cors, ...extra });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Handle a public /api/auth/* request. Returns true if it owned the route. cors = per-request
// credentialed CORS headers (origin-reflected). No principal resolution here — these are the
// unauthenticated endpoints that establish identity.
export async function handleDevAuth(req: IncomingMessage, res: ServerResponse, pathname: string, cors: Record<string, string>): Promise<boolean> {
  const c = cfg();
  if (!c) return false;
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/api/auth/config') {
    send(res, 200, { provider: 'magic-link', providers: ['magic-link'], tos_url: null, privacy_url: null }, {}, cors);
    return true;
  }

  if (method === 'POST' && pathname === '/api/auth/magic-link') {
    await readBody(req); // email ignored in dev — always the pinned dev user
    send(res, 200, { status: 'sent', magic_link: `${c.webOrigin}/login?token=${magicToken(c)}`, code: c.code }, {}, cors);
    return true;
  }

  if (method === 'POST' && pathname === '/api/auth/verify') {
    let body: { token?: string; code?: string };
    try { body = JSON.parse(await readBody(req)) as typeof body; } catch { send(res, 400, { error: 'invalid JSON' }, {}, cors); return true; }
    const okCode = typeof body.code === 'string' && body.code === c.code;
    const okToken = typeof body.token === 'string' && verifyHs256(body.token, c.secret)?.['sub'] === c.userId;
    if (!okCode && !okToken) { send(res, 401, { error: 'invalid code or token' }, {}, cors); return true; }
    const headers: Record<string, string> = {};
    setRefreshCookie(headers, c);
    send(res, 200, { access_token: accessToken(c), user: { id: c.userId, email: c.email } }, headers, cors);
    return true;
  }

  if (method === 'POST' && pathname === '/api/auth/refresh') {
    const cookie = readCookie(req, 'eidan_refresh');
    if (!cookie || verifyHs256(cookie, c.secret)?.['sub'] !== c.userId) { send(res, 401, { error: 'no refresh session' }, {}, cors); return true; }
    send(res, 200, { access_token: accessToken(c), user: { id: c.userId, email: c.email } }, {}, cors);
    return true;
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const headers: Record<string, string> = {};
    clearRefreshCookie(headers);
    send(res, 200, { ok: true }, headers, cors);
    return true;
  }

  return false;
}
