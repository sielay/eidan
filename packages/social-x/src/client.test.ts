// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XClient } from './client.js';

function mockFetch(handler: (url: string, options?: RequestInit) => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) =>
    ({ ok: true, json: async () => handler(String(url), options) }) as Response) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('XClient.postTweet posts with the bearer token', async () => {
  let seen = '';
  const restore = mockFetch((url, options) => {
    seen = url;
    assert.equal((options?.headers as Record<string, string>)?.Authorization, 'Bearer test-token');
    return { data: { id: '1234567890', text: 'Hello, X!' } };
  });
  try {
    const r = await new XClient('test-token').postTweet('Hello, X!');
    assert.ok(seen.includes('/tweets'));
    assert.equal(r.tweetId, '1234567890');
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('XClient.postTweet rejects > 280 chars without a request', async () => {
  const r = await new XClient('t').postTweet('a'.repeat(281));
  assert.equal(r.tweetId, '');
  assert.ok(r.error?.includes('280'));
});

test('XClient.getMe returns the profile', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('/users/me'));
    return { data: { id: '12345', name: 'Test User', username: 'testuser', followers_count: 100, verified: false } };
  });
  try {
    const r = await new XClient('test-token').getMe();
    assert.equal(r.profile?.username, 'testuser');
    assert.equal(r.profile?.followers_count, 100);
  } finally {
    restore();
  }
});

test('XClient.searchTweets maps results', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('/tweets/search/recent'));
    return { data: [{ id: '67890', text: 'Test tweet', author_id: '12345', public_metrics: { like_count: 10 } }] };
  });
  try {
    const r = await new XClient('test-token').searchTweets('test', 20);
    assert.equal(r.tweets.length, 1);
    assert.equal(r.tweets[0]?.text, 'Test tweet');
  } finally {
    restore();
  }
});
