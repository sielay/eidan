// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MastodonClient } from './client.js';

function mockFetch(handler: (url: string, options?: RequestInit) => { ok?: boolean; body?: unknown }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const r = handler(String(url), options);
    const ok = r.ok ?? true;
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ''),
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('MastodonClient builds the base URL from the host', async () => {
  let seen = '';
  const restore = mockFetch((url, options) => {
    seen = url;
    assert.equal((options?.headers as Record<string, string>)?.Authorization, 'Bearer test-token');
    return { body: { id: '99', url: 'https://fosstodon.org/@me/99' } };
  });
  try {
    const r = await new MastodonClient('test-token', 'fosstodon.org').post('Hello, fedi!');
    assert.ok(seen.startsWith('https://fosstodon.org/api/v1/statuses'));
    assert.equal(r.id, '99');
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('MastodonClient accepts a host that already includes a scheme', async () => {
  let seen = '';
  const restore = mockFetch((url) => {
    seen = url;
    return { body: { id: '1' } };
  });
  try {
    await new MastodonClient('t', 'https://mastodon.social/').post('hi');
    assert.ok(seen.startsWith('https://mastodon.social/api/v1/statuses'));
  } finally {
    restore();
  }
});

test('MastodonClient.post surfaces a non-ok response as an error', async () => {
  const restore = mockFetch(() => ({ ok: false, body: 'nope' }));
  try {
    const r = await new MastodonClient('t', 'mastodon.social').post('hi');
    assert.ok(r.error?.includes('Failed to post'));
  } finally {
    restore();
  }
});

test('MastodonClient.search maps statuses', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('/api/v2/search'));
    return { body: { statuses: [{ id: '5', content: 'test toot' }] } };
  });
  try {
    const r = await new MastodonClient('test-token', 'mastodon.social').search('test', 20);
    assert.equal(r.statuses?.length, 1);
    assert.equal(r.statuses?.[0]?.id, '5');
  } finally {
    restore();
  }
});

test('MastodonClient.getProfile fetches verify_credentials then the account', async () => {
  let calls = 0;
  const restore = mockFetch((url) => {
    calls += 1;
    if (url.includes('verify_credentials')) return { body: { id: '42' } };
    assert.ok(url.includes('/api/v1/accounts/42'));
    return { body: { id: '42', acct: 'me', username: 'me' } };
  });
  try {
    const r = await new MastodonClient('test-token', 'mastodon.social').getProfile();
    assert.equal(calls, 2);
    assert.equal(r.account?.id, '42');
  } finally {
    restore();
  }
});
