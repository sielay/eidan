// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlueskyClient } from './client.js';

// Mock global fetch with a handler keyed by URL. createSession is always answered first so the client
// has a session JWT before the operation under test runs.
function mockFetch(handler: (url: string, options?: RequestInit) => { ok?: boolean; status?: number; body: unknown }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const u = String(url);
    if (u.includes('com.atproto.server.createSession')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ did: 'did:plc:test', handle: 'tester.bsky.social', accessJwt: 'access-jwt', refreshJwt: 'refresh-jwt' }),
        text: async () => '',
      } as Response;
    }
    const r = handler(u, options);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('BlueskyClient.post mints a session then creates a record', async () => {
  let seen = '';
  let auth = '';
  const restore = mockFetch((url, options) => {
    seen = url;
    auth = (options?.headers as Record<string, string>)?.Authorization ?? '';
    return { body: { uri: 'at://did:plc:test/app.bsky.feed.post/abc', cid: 'bafycid' } };
  });
  try {
    const r = await new BlueskyClient('tester.bsky.social', 'app-pass').post('Hello, Bluesky!');
    assert.ok(seen.includes('com.atproto.repo.createRecord'));
    assert.equal(auth, 'Bearer access-jwt');
    assert.equal(r.uri, 'at://did:plc:test/app.bsky.feed.post/abc');
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('BlueskyClient.post rejects > 300 graphemes without a createRecord call', async () => {
  let createRecordCalled = false;
  const restore = mockFetch((url) => {
    if (url.includes('createRecord')) createRecordCalled = true;
    return { body: {} };
  });
  try {
    const r = await new BlueskyClient('tester.bsky.social', 'app-pass').post('a'.repeat(301));
    assert.equal(r.uri, '');
    assert.ok(r.error?.includes('300'));
    assert.equal(createRecordCalled, false);
  } finally {
    restore();
  }
});

test('BlueskyClient.post errors when no session can be created (missing credentials)', async () => {
  const r = await new BlueskyClient('', '').post('hi');
  assert.equal(r.uri, '');
  assert.ok(r.error);
});

test('BlueskyClient.search maps results', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('app.bsky.feed.searchPosts'));
    return { body: { posts: [{ uri: 'at://x', author: { handle: 'a.bsky.social' }, record: { text: 'hi' }, likeCount: 3 }] } };
  });
  try {
    const r = await new BlueskyClient('tester.bsky.social', 'app-pass').search('hi', 10);
    assert.equal(r.posts.length, 1);
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('BlueskyClient.readFeed returns the author feed posts', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('app.bsky.feed.getAuthorFeed'));
    return { body: { feed: [{ post: { uri: 'at://y', author: { handle: 'b.bsky.social' }, record: { text: 'yo' } } }] } };
  });
  try {
    const r = await new BlueskyClient('tester.bsky.social', 'app-pass').readFeed(5);
    assert.equal(r.posts.length, 1);
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('BlueskyClient honours a custom service host', async () => {
  let seen = '';
  const restore = mockFetch((url) => {
    seen = url;
    return { body: { posts: [] } };
  });
  try {
    await new BlueskyClient('tester.bsky.social', 'app-pass', 'https://pds.example.com').search('q');
    assert.ok(seen.startsWith('https://pds.example.com/'));
  } finally {
    restore();
  }
});
