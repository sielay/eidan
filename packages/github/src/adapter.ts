// SPDX-License-Identifier: AGPL-3.0-or-later
// GitHub PAT adapter for the connections kit. GitHub has no OAuth for PATs: the user pastes a
// Personal Access Token. The kit's resolver, seeing flavor 'app_password', returns the stored PAT
// as-is — the GitHubClient then uses it directly. The OAuth-flavoured fields below are unused but
// satisfy the OAuthAdapter type.
import type { OAuthAdapter } from '@eidandev/connections-kit';
import { GitHubClient } from './client.js';

export const GITHUB_PROVIDER = 'github';

export const githubAdapter: OAuthAdapter = {
  provider: GITHUB_PROVIDER,
  flavor: 'app_password',
  scopes: [],
  usesRefresh: false,
  endpoints: () => ({ authUrl: '', tokenUrl: '' }),
  async fetchIdentity() {
    return { handle: '', id: '' };
  },
  // The "Test" button: resolve the stored PAT and call GitHub to confirm it works.
  async testConnection({ accessToken, account }) {
    const client = new GitHubClient(accessToken);
    const r = await client.verify();
    return r.ok ? { ok: true, handle: r.login ?? '' } : { ok: false, error: r.error ?? 'verification failed' };
  },
};
