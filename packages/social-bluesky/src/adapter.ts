// SPDX-License-Identifier: AGPL-3.0-or-later
// Bluesky (AT Protocol) app-password adapter for the connections kit. Bluesky has no OAuth: the user
// pastes a handle + app password (+ optional service URL). The kit's resolver, seeing flavor
// 'app_password', returns the stored credential (the app password) as-is — the BlueskyClient then
// mints a short-lived session JWT per call. The OAuth-flavoured fields below are unused but satisfy
// the OAuthAdapter type.
import type { OAuthAdapter } from '@eidandev/connections-kit';
import { BlueskyClient } from './client.js';

export const BLUESKY_PROVIDER = 'bluesky';

export const blueskyAdapter: OAuthAdapter = {
  provider: BLUESKY_PROVIDER,
  flavor: 'app_password',
  scopes: [],
  usesRefresh: false,
  endpoints: () => ({ authUrl: '', tokenUrl: '' }),
  async fetchIdentity() {
    return { handle: '', id: '' };
  },
  // The "Test" button: app_password can't be probed via fetchIdentity, so mint a real session with
  // the stored credential (accessToken IS the app password for this flavor).
  async testConnection({ accessToken, account }) {
    const client = new BlueskyClient(account.external_handle, accessToken, account.host || undefined);
    const r = await client.verify();
    return r.ok ? { ok: true, handle: account.external_handle } : { ok: false, error: r.error ?? 'sign-in failed' };
  },
};
