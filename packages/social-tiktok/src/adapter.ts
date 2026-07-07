// SPDX-License-Identifier: AGPL-3.0-or-later
// TikTok OAuth2 adapter for the connections kit. Uses TikTok's Login Kit: authorize at
// www.tiktok.com/v2/auth/authorize, exchange at open.tiktokapis.com/v2/oauth/token. TikTok deviates
// from RFC 6749 in two ways the kit now supports per-adapter: the client id is carried as
// `client_key` (not `client_id`), and the authorize scope list is comma-separated (not space). Access
// tokens are short-lived (~24h) with a durable refresh token, so usesRefresh is true.
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const TIKTOK_PROVIDER = 'tiktok';

export const tiktokAdapter: OAuthAdapter = {
  provider: TIKTOK_PROVIDER,
  flavor: 'oauth2',
  usesRefresh: true,
  clientIdParam: 'client_key',
  scopeSeparator: ',',
  // Read (profile + own videos) plus publish. `video.publish` needs TikTok's Content Posting API
  // approval; unaudited apps can still publish but only as SELF_ONLY (private) test posts.
  scopes: [
    'user.info.basic',
    'user.info.profile',
    'user.info.stats',
    'video.list',
    'video.publish',
  ],
  endpoints: () => ({
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
  }),
  async fetchIdentity(accessToken: string) {
    try {
      const r = await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
        { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
      );
      const j = (await r.json().catch(() => ({}))) as {
        data?: { user?: { open_id?: string; display_name?: string } };
      };
      const u = j.data?.user;
      if (u?.open_id) return { handle: u.display_name ?? '', id: u.open_id };
    } catch {
      // fall through
    }
    return { handle: '', id: '' };
  },
};
