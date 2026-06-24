// SPDX-License-Identifier: AGPL-3.0-or-later
// X (Twitter) OAuth2 + PKCE adapter for the connections kit. Confidential clients authenticate to the
// token endpoint with HTTP Basic; `offline.access` yields a rotating refresh token.
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const X_PROVIDER = 'x';

export const xAdapter: OAuthAdapter = {
  provider: X_PROVIDER,
  flavor: 'oauth2_pkce',
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  usesRefresh: true,
  tokenAuthStyle: 'basic',
  endpoints: () => ({
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
  }),
  async fetchIdentity(accessToken: string) {
    const r = await fetch('https://api.twitter.com/2/users/me', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => ({}))) as { data?: { id?: string; username?: string } };
    return { handle: j.data?.username ?? '', id: j.data?.id ?? '' };
  },
};
