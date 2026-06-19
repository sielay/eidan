// SPDX-License-Identifier: AGPL-3.0-or-later
// Google OAuth2 helper for the eidan `gdrive` plugin. Protocol bits only: mint a fresh
// access token from a stored refresh token. The durable refresh token lives in the vault.
//
// This mirrors `packages/google/src/oauth.ts` verbatim in shape. It is duplicated rather than
// imported because `@eidandev/google` only exports `plugin` from its package root, not the
// protocol helper. When the shared Google-account connection registry (the iCal-style
// `plugin_google.accounts` table + admin screen) lands on core, both plugins should resolve the
// same vaulted OAuth credentials (client id/secret + refresh token) from that registry — the only
// difference between them being the requested scope (gmail.readonly vs drive.readonly). At that
// point this helper and `packages/google/src/oauth.ts` collapse into one shared module.
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class OAuthError extends Error {}

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
