// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure unit tests for the OAuth protocol helpers (no network): PKCE generation + consent URL build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generatePkce, buildAuthUrl, OAuthError } from './oauth.js';
import type { OAuthAdapter } from './adapter.js';

const base: OAuthAdapter = {
  provider: 'test',
  flavor: 'oauth2',
  scopes: ['read', 'write'],
  usesRefresh: true,
  endpoints: () => ({ authUrl: 'https://example.com/authorize', tokenUrl: 'https://example.com/token' }),
  fetchIdentity: async () => ({ handle: 'me', id: '1' }),
};

test('generatePkce returns a verifier whose S256 hash is the challenge', () => {
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

test('buildAuthUrl emits standard params + adapter scopes + extra params', () => {
  const url = new URL(
    buildAuthUrl({
      adapter: { ...base, extraAuthParams: { access_type: 'offline', prompt: 'consent' } },
      clientId: 'cid',
      redirectUri: 'https://app/cb',
      state: 'acc-1',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://example.com/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app/cb');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'read write');
  assert.equal(url.searchParams.get('state'), 'acc-1');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge'), null); // not PKCE
});

test('buildAuthUrl honours clientIdParam + scopeSeparator (TikTok-shaped)', () => {
  const url = new URL(
    buildAuthUrl({
      adapter: { ...base, clientIdParam: 'client_key', scopeSeparator: ',' },
      clientId: 'ck',
      redirectUri: 'https://app/cb',
      state: 'acc-1',
    }),
  );
  assert.equal(url.searchParams.get('client_key'), 'ck');
  assert.equal(url.searchParams.get('client_id'), null); // renamed, not both
  assert.equal(url.searchParams.get('scope'), 'read,write'); // comma-separated
});

test('buildAuthUrl adds PKCE params for oauth2_pkce and requires a challenge', () => {
  const pkce = generatePkce();
  const url = new URL(
    buildAuthUrl({
      adapter: { ...base, flavor: 'oauth2_pkce' },
      clientId: 'cid',
      redirectUri: 'https://app/cb',
      state: 's',
      codeChallenge: pkce.challenge,
    }),
  );
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

  assert.throws(
    () =>
      buildAuthUrl({ adapter: { ...base, flavor: 'oauth2_pkce' }, clientId: 'c', redirectUri: 'r', state: 's' }),
    OAuthError,
  );
});

test('buildAuthUrl threads host into per-host endpoints', () => {
  const adapter: OAuthAdapter = {
    ...base,
    flavor: 'dynamic_app',
    endpoints: (host?: string) => ({
      authUrl: `https://${host}/oauth/authorize`,
      tokenUrl: `https://${host}/oauth/token`,
    }),
  };
  const url = new URL(
    buildAuthUrl({ adapter, clientId: 'cid', redirectUri: 'https://app/cb', state: 's', host: 'fosstodon.org' }),
  );
  assert.equal(url.origin + url.pathname, 'https://fosstodon.org/oauth/authorize');
});
