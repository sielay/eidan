// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for account selection + token resolution. Uses an in-memory AccountStore + a fake
// ctx.vault; the refresh path mocks global fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import type { OAuthAdapter } from './adapter.js';
import type { AccountStore, ConnAccount } from './registry.js';
import { resolveAccessToken, pickAccount, NotConnectedError, AccountResolveError } from './resolve.js';

function acc(over: Partial<ConnAccount>): ConnAccount {
  return {
    id: 'a1',
    name: 'Personal',
    slug: 'personal',
    host: '',
    external_handle: 'me',
    external_id: '1',
    client_vault_key: 'EIDAN_X_CLIENT_personal',
    token_vault_key: 'EIDAN_X_TOKEN_personal',
    refresh_vault_key: 'EIDAN_X_REFRESH_personal',
    token_expires_at: null,
    status: 'active',
    context: '',
    metadata: {},
    ...over,
  };
}

function store(rows: ConnAccount[]): AccountStore & { expiryUpdates: Array<[string, Date | null]> } {
  const expiryUpdates: Array<[string, Date | null]> = [];
  return {
    expiryUpdates,
    listAccounts: async () => rows,
    getAccountById: async (id) => rows.find((r) => r.id === id) ?? null,
    setPending: async () => {},
    setActive: async () => {},
    updateExpiry: async (id, e) => {
      expiryUpdates.push([id, e]);
    },
  };
}

function ctxWith(secrets: Record<string, string>): ToolContext {
  return {
    vault: {
      resolve: async (tpl: string) => {
        const name = tpl.replace(/^\$\{|\}$/g, '');
        return secrets[name] ?? '';
      },
    },
  } as unknown as ToolContext;
}

const oauthAdapter: OAuthAdapter = {
  provider: 'x',
  flavor: 'oauth2_pkce',
  scopes: ['tweet.read'],
  usesRefresh: true,
  endpoints: () => ({ authUrl: 'https://x/a', tokenUrl: 'https://x/token' }),
  fetchIdentity: async () => ({ handle: 'me', id: '1' }),
};

test('pickAccount: first when unspecified, else by slug/name', () => {
  const rows = [acc({ id: 'a1', slug: 'personal', name: 'Personal' }), acc({ id: 'a2', slug: 'work', name: 'Work' })];
  assert.equal(pickAccount(rows, undefined)?.id, 'a1');
  assert.equal(pickAccount(rows, 'work')?.id, 'a2');
  assert.equal(pickAccount(rows, 'Work')?.id, 'a2');
  assert.equal(pickAccount(rows, 'nope'), undefined);
  assert.equal(pickAccount([], 'x'), undefined);
});

test('NotConnectedError when no accounts (so caller can fall back to legacy)', async () => {
  await assert.rejects(
    () => resolveAccessToken(store([]), oauthAdapter, ctxWith({}), {}),
    NotConnectedError,
  );
});

test('AccountResolveError when the named account does not exist', async () => {
  await assert.rejects(
    () => resolveAccessToken(store([acc({})]), oauthAdapter, ctxWith({}), { accountSelector: 'missing' }),
    AccountResolveError,
  );
});

test('returns the stored token when present and not expired', async () => {
  const future = new Date(Date.now() + 3_600_000);
  const res = await resolveAccessToken(
    store([acc({ token_expires_at: future })]),
    oauthAdapter,
    ctxWith({ EIDAN_X_TOKEN_personal: 'tok-123' }),
    {},
  );
  assert.equal(res.accessToken, 'tok-123');
});

test('app_password adapter returns the stored credential as-is', async () => {
  const bsky: OAuthAdapter = { ...oauthAdapter, provider: 'bluesky', flavor: 'app_password', usesRefresh: false };
  const res = await resolveAccessToken(
    store([acc({ token_vault_key: 'EIDAN_BLUESKY_TOKEN_personal' })]),
    bsky,
    ctxWith({ EIDAN_BLUESKY_TOKEN_personal: 'app-pw' }),
    {},
  );
  assert.equal(res.accessToken, 'app-pw');
});

test('refreshes + re-seals an expired token', async () => {
  const past = new Date(Date.now() - 1000);
  const s = store([acc({ token_expires_at: past })]);
  const sealed: Record<string, string> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ access_token: 'fresh-tok', expires_in: 7200 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    const res = await resolveAccessToken(
      s,
      oauthAdapter,
      ctxWith({
        EIDAN_X_TOKEN_personal: 'stale',
        EIDAN_X_REFRESH_personal: 'refresh-tok',
        EIDAN_X_CLIENT_personal: JSON.stringify({ client_id: 'c', client_secret: 's' }),
      }),
      { seal: async (n, v) => void (sealed[n] = v) },
    );
    assert.equal(res.accessToken, 'fresh-tok');
    assert.equal(sealed['EIDAN_X_TOKEN_personal'], 'fresh-tok');
    assert.equal(s.expiryUpdates.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
