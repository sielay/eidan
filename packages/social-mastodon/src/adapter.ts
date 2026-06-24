// SPDX-License-Identifier: AGPL-3.0-or-later
// Mastodon OAuth2 adapter for the connections kit. Mastodon is federated: each account lives on a
// HOST (instance domain) and there is no operator-supplied client. The kit registers an OAuth app
// with each instance on demand (flavor 'dynamic_app') via POST /api/v1/apps and caches it per host.
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const MASTODON_PROVIDER = 'mastodon';

export const mastodonAdapter: OAuthAdapter = {
  provider: MASTODON_PROVIDER,
  flavor: 'dynamic_app',
  scopes: ['read', 'write'],
  usesRefresh: false,
  endpoints: (host?: string) => ({
    authUrl: `https://${host}/oauth/authorize`,
    tokenUrl: `https://${host}/oauth/token`,
  }),
  async registerApp(host: string, redirectUri: string): Promise<{ clientId: string; clientSecret: string }> {
    const body = new URLSearchParams({
      client_name: 'eidan',
      redirect_uris: redirectUri,
      scopes: 'read write',
      website: '',
    });
    const r = await fetch(`https://${host}/api/v1/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status !== 200) {
      throw new Error(`Mastodon app registration failed on ${host}: HTTP ${r.status}`);
    }
    const j = (await r.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
    if (!j.client_id || !j.client_secret) {
      throw new Error(`Mastodon app registration on ${host} returned no client credentials`);
    }
    return { clientId: j.client_id, clientSecret: j.client_secret };
  },
  async fetchIdentity(accessToken: string, opts?: { host?: string; type?: string }) {
    const host = opts?.host;
    try {
      const r = await fetch(`https://${host}/api/v1/accounts/verify_credentials`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await r.json().catch(() => ({}))) as { acct?: string; username?: string; id?: string | number };
      return { handle: j.acct ?? j.username ?? '', id: String(j.id ?? '') };
    } catch {
      return { handle: '', id: '' };
    }
  },
};
