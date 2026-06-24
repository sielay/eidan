// SPDX-License-Identifier: AGPL-3.0-or-later
// YouTube (Google) OAuth2 adapter for the connections kit. Uses offline access + a durable refresh
// token (Google issues the refresh token only on first consent, so we force consent and require it).
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const YOUTUBE_PROVIDER = 'youtube';

export const youtubeAdapter: OAuthAdapter = {
  provider: YOUTUBE_PROVIDER,
  flavor: 'oauth2',
  usesRefresh: true,
  requireRefreshOnConnect: true,
  scopes: [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'openid',
    'email',
  ],
  extraAuthParams: {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
  endpoints: () => ({
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
  }),
  async fetchIdentity(accessToken: string) {
    // Prefer the YouTube channel (title + id). But a valid Google token may have NO channel (the
    // account never created one), and channels?mine=true then returns empty — which must NOT read as
    // "invalid token". So fall back to the OpenID userinfo email (we request openid+email), which
    // confirms the token works and gives a usable handle.
    try {
      const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await r.json().catch(() => ({}))) as {
        items?: Array<{ id?: string; snippet?: { title?: string } }>;
      };
      const item = j.items?.[0];
      if (item?.id) return { handle: item.snippet?.title ?? '', id: item.id };
    } catch {
      // fall through to userinfo
    }
    try {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 200) {
        const info = (await r.json().catch(() => ({}))) as { email?: string; sub?: string };
        if (info.email || info.sub) return { handle: info.email ?? '', id: info.sub ?? '' };
      }
    } catch {
      // ignore
    }
    return { handle: '', id: '' };
  },
};
