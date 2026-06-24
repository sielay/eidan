// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramClient } from './client.js';

function mockFetch(handler: (url: string, options?: RequestInit) => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) =>
    ({ ok: true, status: 200, json: async () => handler(String(url), options), text: async () => '' }) as Response) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('InstagramClient.getAuthenticatedUser sends the bearer token and returns the profile', async () => {
  let seen = '';
  const restore = mockFetch((url, options) => {
    seen = url;
    assert.equal((options?.headers as Record<string, string>)?.Authorization, 'Bearer test-token');
    return { id: '123', username: 'testuser', followers_count: 100 };
  });
  try {
    const r = await new InstagramClient('test-token').getAuthenticatedUser();
    assert.ok(seen.includes('/me'));
    assert.equal(r?.username, 'testuser');
    assert.equal(r?.followers_count, 100);
  } finally {
    restore();
  }
});

test('InstagramClient.getUserFeed maps results', async () => {
  const restore = mockFetch((url) => {
    if (url.includes('/me/media')) {
      return { data: [{ id: 'm1', caption: 'hi', media_type: 'IMAGE', permalink: 'p', timestamp: 't', like_count: 5 }] };
    }
    return { id: '123', username: 'testuser' };
  });
  try {
    const feed = await new InstagramClient('test-token').getUserFeed(20);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]?.id, 'm1');
  } finally {
    restore();
  }
});

test('InstagramClient.searchHashtag returns the first match', async () => {
  const restore = mockFetch((url) => {
    if (url.includes('/ig_hashtag_search')) {
      return { data: [{ id: 'h1', name: 'sunset' }] };
    }
    return { id: '123', username: 'testuser' };
  });
  try {
    const hashtag = await new InstagramClient('test-token').searchHashtag('#sunset');
    assert.equal(hashtag?.id, 'h1');
    assert.equal(hashtag?.name, 'sunset');
  } finally {
    restore();
  }
});

test('InstagramClient.postMedia creates then publishes a container', async () => {
  let published = false;
  const restore = mockFetch((url) => {
    if (url.includes('/me/media_publish')) {
      published = true;
      return { id: 'published-1' };
    }
    if (url.includes('/me/media')) {
      return { id: 'container-1' };
    }
    return { id: '123', username: 'testuser' };
  });
  try {
    const r = await new InstagramClient('test-token').postMedia('https://example.com/i.jpg', 'caption');
    assert.ok(published);
    assert.equal(r.id, 'published-1');
  } finally {
    restore();
  }
});
