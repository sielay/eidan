// SPDX-License-Identifier: AGPL-3.0-or-later
// Google OAuth2 helper for the eidan `google` plugin. Protocol bits only: mint a fresh access
// token from a stored refresh token (refreshAccessToken — used per call), and the "Connect with
// Google" auth-code exchange (exchangeCode — used once by the admin screen's callback). The durable
// refresh token + the operator's OAuth client id/secret live in the vault, never here.
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

// One Google account serves both Gmail and Drive (the gdrive bundle resolves the same connection),
// so request both read scopes up front + the identity claim (to show which mailbox got connected).
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
];

export class OAuthError extends Error {}

// Build the consent URL the operator is sent to. `access_type=offline` + `prompt=consent` force
// Google to return a refresh_token (it otherwise omits it on repeat consents).
export function buildAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: (args.scopes ?? GMAIL_SCOPES).join(' '),
    state: args.state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface ExchangedTokens {
  refreshToken: string;
  accessToken: string;
}

// Exchange an auth code for tokens. The refresh_token is the durable credential we seal in the vault;
// the access_token is returned so the caller can immediately look up the connected email.
export async function exchangeCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<ExchangedTokens> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  let resp: Response;
  try {
    resp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (exc) {
    throw new OAuthError(`code exchange failed: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
  if (resp.status !== 200) throw new OAuthError(`token endpoint returned HTTP ${resp.status}`);
  const tok = (await resp.json()) as { access_token?: string; refresh_token?: string };
  if (!tok.refresh_token) {
    throw new OAuthError(
      'Google returned no refresh_token — revoke the app under your Google account and reconnect ' +
        '(a refresh token is only issued on first consent).',
    );
  }
  return { refreshToken: tok.refresh_token, accessToken: tok.access_token ?? '' };
}

// Look up the email of the mailbox an access token belongs to (OpenID Connect userinfo).
export async function fetchEmail(accessToken: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return '';
  }
  if (resp.status !== 200) return '';
  const info = (await resp.json()) as { email?: string };
  return info.email ?? '';
}

export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: 'refresh_token',
  });
  let resp: Response;
  try {
    resp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (exc) {
    throw new OAuthError(`token request failed: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
  if (resp.status !== 200) throw new OAuthError(`token endpoint returned HTTP ${resp.status}`);
  const tok = (await resp.json()) as { access_token?: string };
  if (!tok.access_token) throw new OAuthError('token refresh returned no access_token');
  return tok.access_token;
}
