// SPDX-License-Identifier: AGPL-3.0-or-later
// Meta Threads OAuth2 adapter for the connections kit. The Threads access token is a long-lived
// bearer; this flavor does not rotate refresh tokens (usesRefresh false).
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const THREADS_PROVIDER = 'threads';

export const threadsAdapter: OAuthAdapter = {
  provider: THREADS_PROVIDER,
  flavor: 'oauth2',
  scopes: ['threads_basic', 'threads_content_publish'],
  usesRefresh: false,
  endpoints: () => ({
    authUrl: 'https://threads.net/oauth/authorize',
    tokenUrl: 'https://graph.threads.net/oauth/access_token',
  }),
  async fetchIdentity(accessToken: string) {
    try {
      const r = await fetch(
        `https://graph.threads.net/me?fields=id,username&access_token=${accessToken}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const j = (await r.json().catch(() => ({}))) as { id?: string; username?: string };
      return { handle: j.username ?? '', id: j.id ?? '' };
    } catch {
      return { handle: '', id: '' };
    }
  },
};
