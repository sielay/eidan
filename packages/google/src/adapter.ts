// SPDX-License-Identifier: AGPL-3.0-or-later
// Google OAuth2 adapter for the connections kit. Standard authorization-code grant; the durable
// refresh token Google issues (only on first consent — access_type=offline + prompt=consent) lets
// the kit mint short-lived access tokens per call. One connected Google account serves both Gmail
// and Drive, so the consent grant carries both read scopes plus the identity claim (the mailbox).
import type { OAuthAdapter } from '@eidandev/connections-kit';
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, GMAIL_SCOPES } from './oauth.js';

export const GOOGLE_PROVIDER = 'google';

export const googleAdapter: OAuthAdapter = {
  provider: GOOGLE_PROVIDER,
  flavor: 'oauth2',
  scopes: GMAIL_SCOPES,
  usesRefresh: true,
  requireRefreshOnConnect: true,
  extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  endpoints: () => ({ authUrl: GOOGLE_AUTH_URL, tokenUrl: GOOGLE_TOKEN_URL }),
  async fetchIdentity(accessToken: string) {
    let resp: Response;
    try {
      resp = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { handle: '', id: '' };
    }
    if (resp.status !== 200) return { handle: '', id: '' };
    const info = (await resp.json().catch(() => ({}))) as { email?: string };
    return { handle: info.email ?? '', id: '' };
  },
};
