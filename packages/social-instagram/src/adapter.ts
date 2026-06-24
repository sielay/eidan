// SPDX-License-Identifier: AGPL-3.0-or-later
// Instagram OAuth2 adapter for the connections kit. Uses the current "Instagram API with Instagram
// Login" flow: authorize at www.instagram.com/oauth/authorize with the app's INSTAGRAM app id (from
// the Meta app → Instagram product → API setup with Instagram login), and instagram_business_* scopes.
// (The legacy api.instagram.com Basic Display flow + instagram_basic scopes is retired — Meta rejects
// it with "Invalid platform app".) Long-lived tokens, no classic refresh.
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const INSTAGRAM_PROVIDER = 'instagram';

export const instagramAdapter: OAuthAdapter = {
  provider: INSTAGRAM_PROVIDER,
  flavor: 'oauth2',
  scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
  usesRefresh: false,
  endpoints: () => ({
    authUrl: 'https://www.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
  }),
  async fetchIdentity(accessToken: string) {
    try {
      const r = await fetch(
        `https://graph.instagram.com/me?fields=id,username&access_token=${accessToken}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const j = (await r.json().catch(() => ({}))) as { id?: string; username?: string };
      return { handle: j.username ?? '', id: j.id ?? '' };
    } catch {
      return { handle: '', id: '' };
    }
  },
};
