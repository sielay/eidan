// SPDX-License-Identifier: AGPL-3.0-or-later
// The OAuth2 protocol skeleton, parameterised by an OAuthAdapter. Protocol bits only: build the
// consent URL, exchange an auth code for tokens, refresh an access token, and generate a PKCE pair.
// All credentials (client id/secret, refresh token) live in the vault, never here.
import { createHash, randomBytes } from 'node:crypto';
import type { OAuthAdapter } from './adapter.js';

export class OAuthError extends Error {}

const TIMEOUT_MS = 15_000;

// Resolve how client credentials are presented to the token endpoint. Returns the headers to add and
// whether to also place the secret in the form body.
function clientAuth(
  adapter: OAuthAdapter,
  clientId: string,
  clientSecret: string,
): { headers: Record<string, string>; bodySecret: boolean } {
  if (adapter.tokenAuthStyle === 'basic' && clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return { headers: { authorization: `Basic ${basic}` }, bodySecret: false };
  }
  return { headers: {}, bodySecret: true };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

// RFC 7636 S256 PKCE pair. The verifier is a high-entropy random string; the challenge is its
// base64url-encoded SHA-256. The verifier is stashed (server-side) on the pending account and
// replayed at code exchange.
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface BuildAuthUrlArgs {
  adapter: OAuthAdapter;
  clientId: string;
  redirectUri: string;
  state: string;
  host?: string;
  codeChallenge?: string;
  scopes?: string[]; // per-app override; falls back to adapter.scopes
}

export function buildAuthUrl(args: BuildAuthUrlArgs): string {
  const { authUrl } = args.adapter.endpoints(args.host);
  const scopes = args.scopes && args.scopes.length ? args.scopes : args.adapter.scopes;
  const idParam = args.adapter.clientIdParam ?? 'client_id';
  const scopeSep = args.adapter.scopeSeparator ?? ' ';
  const params = new URLSearchParams({
    [idParam]: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: scopes.join(scopeSep),
    state: args.state,
  });
  for (const [k, v] of Object.entries(args.adapter.extraAuthParams ?? {})) params.set(k, v);
  if (args.adapter.flavor === 'oauth2_pkce') {
    if (!args.codeChallenge) throw new OAuthError('PKCE flow requires a code_challenge');
    params.set('code_challenge', args.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${authUrl}?${params.toString()}`;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string; // '' when the platform issues none (or doesn't on this grant)
  expiresIn: number; // seconds; 0 when the platform omits it
}

async function postForm(
  url: string,
  body: URLSearchParams,
  what: string,
  extraHeaders?: Record<string, string>,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...extraHeaders },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (exc) {
    throw new OAuthError(`${what} failed: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
  const text = await resp.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthError(`${what}: token endpoint returned non-JSON (HTTP ${resp.status})`);
  }
  if (resp.status !== 200) {
    const desc = (json['error_description'] ?? json['error'] ?? `HTTP ${resp.status}`) as string;
    throw new OAuthError(`${what}: ${desc}`);
  }
  return json;
}

export interface ExchangeCodeArgs {
  adapter: OAuthAdapter;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  host?: string;
  codeVerifier?: string;
}

export async function exchangeCode(args: ExchangeCodeArgs): Promise<ExchangedTokens> {
  const { tokenUrl } = args.adapter.endpoints(args.host);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    [args.adapter.clientIdParam ?? 'client_id']: args.clientId,
    redirect_uri: args.redirectUri,
  });
  const auth = clientAuth(args.adapter, args.clientId, args.clientSecret);
  // PKCE providers may accept a public client (no secret). Send the secret when we have one.
  if (args.clientSecret && auth.bodySecret) body.set('client_secret', args.clientSecret);
  if (args.codeVerifier) body.set('code_verifier', args.codeVerifier);
  const tok = await postForm(tokenUrl, body, 'code exchange', auth.headers);
  const accessToken = typeof tok['access_token'] === 'string' ? tok['access_token'] : '';
  if (!accessToken) throw new OAuthError('code exchange returned no access_token');
  return {
    accessToken,
    refreshToken: typeof tok['refresh_token'] === 'string' ? tok['refresh_token'] : '',
    expiresIn: typeof tok['expires_in'] === 'number' ? tok['expires_in'] : 0,
  };
}

export interface RefreshArgs {
  adapter: OAuthAdapter;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  host?: string;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string; // '' when the platform doesn't rotate it (keep the existing one)
  expiresIn: number;
}

export async function refreshAccessToken(args: RefreshArgs): Promise<RefreshedTokens> {
  const { tokenUrl } = args.adapter.endpoints(args.host);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    [args.adapter.clientIdParam ?? 'client_id']: args.clientId,
  });
  const auth = clientAuth(args.adapter, args.clientId, args.clientSecret);
  if (args.clientSecret && auth.bodySecret) body.set('client_secret', args.clientSecret);
  const tok = await postForm(tokenUrl, body, 'token refresh', auth.headers);
  const accessToken = typeof tok['access_token'] === 'string' ? tok['access_token'] : '';
  if (!accessToken) throw new OAuthError('token refresh returned no access_token');
  return {
    accessToken,
    refreshToken: typeof tok['refresh_token'] === 'string' ? tok['refresh_token'] : '',
    expiresIn: typeof tok['expires_in'] === 'number' ? tok['expires_in'] : 0,
  };
}
