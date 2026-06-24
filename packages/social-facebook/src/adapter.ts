// SPDX-License-Identifier: AGPL-3.0-or-later
// Facebook OAuth2 adapter for the connections kit. Standard authorization-code grant; Facebook does
// not issue refresh tokens (long-lived access tokens are minted instead). The Graph API authenticates
// with an `access_token` query param rather than a Bearer header.
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const FACEBOOK_PROVIDER = 'facebook';

export const facebookAdapter: OAuthAdapter = {
  provider: FACEBOOK_PROVIDER,
  flavor: 'oauth2',
  scopes: ['pages_manage_posts', 'pages_read_engagement', 'public_profile'],
  usesRefresh: false,
  endpoints: () => ({
    authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
  }),
  async fetchIdentity(accessToken: string) {
    try {
      const r = await fetch(
        `https://graph.facebook.com/me?fields=id,name&access_token=${accessToken}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const j = (await r.json().catch(() => ({}))) as { id?: string; name?: string };
      return { handle: j.name ?? '', id: j.id ?? '' };
    } catch {
      return { handle: '', id: '' };
    }
  },
};
