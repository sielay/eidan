// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadsClient } from './client.js';

function mockFetch(handler: (url: string, options?: RequestInit) => { ok?: boolean; json: () => unknown } | Error): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const out = handler(String(url), options);
    if (out instanceof Error) throw out;
    return { ok: out.ok ?? true, status: 200, json: async () => out.json() } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('post returns error when text is empty', async () => {
  const r = await new ThreadsClient('token123').post('');
  assert.equal(r.id, '');
  assert.ok(r.error?.includes('required'));
});

test('post returns error when text exceeds 500 characters', async () => {
  const r = await new ThreadsClient('token123').post('x'.repeat(501));
  assert.equal(r.id, '');
  assert.ok(r.error?.includes('500 character limit'));
});

test('post succeeds with valid text', async () => {
  let seen = '';
  const restore = mockFetch((url, options) => {
    seen = url;
    assert.equal((options?.headers as Record<string, string>)?.Authorization, 'Bearer token123');
    return { json: () => ({ id: 'thread-123', thread_id: 'thread-123' }) };
  });
  try {
    const r = await new ThreadsClient('token123').post('Hello Threads!');
    assert.ok(seen.includes('/me/threads'));
    assert.equal(r.id, 'thread-123');
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('post with reply_to includes reply_to_id', async () => {
  let capturedBody: Record<string, unknown> = {};
  const restore = mockFetch((_url, options) => {
    capturedBody = JSON.parse(options!.body as string);
    return { json: () => ({ id: 'thread-reply-123', thread_id: 'thread-reply-123' }) };
  });
  try {
    const r = await new ThreadsClient('token123').post('Reply text', 'parent-thread-123');
    assert.equal(r.id, 'thread-reply-123');
    assert.equal(capturedBody['reply_to_id'], 'parent-thread-123');
  } finally {
    restore();
  }
});

test('post handles network error gracefully', async () => {
  const restore = mockFetch(() => new Error('Network error'));
  try {
    const r = await new ThreadsClient('token123').post('Hello world');
    assert.equal(r.id, '');
    assert.ok(r.error?.includes('Failed to post'));
  } finally {
    restore();
  }
});

test('search returns error when query is empty', async () => {
  const r = await new ThreadsClient('token123').search('   ');
  assert.deepEqual(r.posts, []);
  assert.ok(r.error?.includes('required'));
});

test('search succeeds with valid query', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('ig_hashtag_search'));
    return { json: () => ({ data: [{ id: 'hashtag-123', name: 'threads' }] }) };
  });
  try {
    const r = await new ThreadsClient('token123').search('threads');
    assert.equal(r.posts.length, 1);
    assert.equal(r.posts[0]?.text, '#threads');
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('search respects limit parameter', async () => {
  const restore = mockFetch(() => ({
    json: () => ({
      data: [
        { id: 'tag1', name: 'threads' },
        { id: 'tag2', name: 'testing' },
        { id: 'tag3', name: 'ai' },
      ],
    }),
  }));
  try {
    const r = await new ThreadsClient('token123').search('test', 2);
    assert.equal(r.posts.length, 2);
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('search handles network error gracefully', async () => {
  const restore = mockFetch(() => new Error('Network error'));
  try {
    const r = await new ThreadsClient('token123').search('test');
    assert.deepEqual(r.posts, []);
    assert.ok(r.error?.includes('Failed to search'));
  } finally {
    restore();
  }
});

test('getProfile succeeds with valid token', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('/me'));
    return {
      json: () => ({
        data: {
          id: 'user-123',
          username: 'testuser',
          name: 'Test User',
          biography: 'Test bio',
          follower_count: 1000,
          following_count: 500,
          is_verified: true,
          website: 'https://example.com',
        },
      }),
    };
  });
  try {
    const r = await new ThreadsClient('token123').getProfile();
    assert.ok(r.user);
    assert.equal(r.user?.username, 'testuser');
    assert.equal(r.user?.follower_count, 1000);
    assert.equal(r.user?.is_verified, true);
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('getProfile handles network error gracefully', async () => {
  const restore = mockFetch(() => new Error('Network error'));
  try {
    const r = await new ThreadsClient('token123').getProfile();
    assert.equal(r.user, null);
    assert.ok(r.error?.includes('Failed to get profile'));
  } finally {
    restore();
  }
});

test('listTimeline succeeds with valid token', async () => {
  const restore = mockFetch((url) => {
    assert.ok(url.includes('/me/threads'));
    return {
      json: () => ({
        data: [
          {
            id: 'post-1',
            text: 'Hello Threads!',
            timestamp: '2026-06-22T10:00:00Z',
            permalink: 'https://threads.net/t/123',
            like_count: 42,
            reply_count: 5,
            repost_count: 3,
          },
        ],
      }),
    };
  });
  try {
    const r = await new ThreadsClient('token123').listTimeline();
    assert.equal(r.posts.length, 1);
    assert.equal(r.posts[0]?.text, 'Hello Threads!');
    assert.equal(r.posts[0]?.like_count, 42);
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('listTimeline respects limit parameter', async () => {
  const restore = mockFetch(() => ({
    json: () => ({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: `post-${i}`,
        text: `Post ${i}`,
        timestamp: '2026-06-22T10:00:00Z',
        permalink: `https://threads.net/t/${i}`,
      })),
    }),
  }));
  try {
    const r = await new ThreadsClient('token123').listTimeline(3);
    assert.equal(r.posts.length, 3);
    assert.equal(r.error, undefined);
  } finally {
    restore();
  }
});

test('listTimeline handles network error gracefully', async () => {
  const restore = mockFetch(() => new Error('Network error'));
  try {
    const r = await new ThreadsClient('token123').listTimeline();
    assert.deepEqual(r.posts, []);
    assert.ok(r.error?.includes('Failed to list timeline'));
  } finally {
    restore();
  }
});
