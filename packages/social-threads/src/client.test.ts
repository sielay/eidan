// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadsClient } from './client.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

let fetchCalls: Array<{ url: string; options: RequestInit | undefined }> = [];
let fetchResponses: Map<string, Response | Error> = new Map();

const mockFetch = (url: string | URL, options?: RequestInit): Response | Promise<Response> => {
  const urlStr = String(url);
  fetchCalls.push({ url: urlStr, options });

  if (fetchResponses.has(urlStr)) {
    const response = fetchResponses.get(urlStr)!;
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  for (const [key, response] of fetchResponses.entries()) {
    let matches = false;
    if (key instanceof RegExp) {
      matches = key.test(urlStr);
    } else {
      const keyStr = String(key);
      const basePart = keyStr.split('?')[0] || '';
      if (urlStr.includes(basePart) && keyStr.includes('?')) {
        const keyUrl = new URL(keyStr);
        const givenUrl = new URL(urlStr);
        matches = true;
        for (const [param, value] of keyUrl.searchParams.entries()) {
          if (givenUrl.searchParams.get(param) !== value) {
            matches = false;
            break;
          }
        }
      }
    }
    if (matches) {
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }
  }

  return new Response(JSON.stringify({ error: 'Not mocked' }), {
    status: 404,
  });
};

const setupFetchMocks = () => {
  fetchCalls = [];
  fetchResponses.clear();
  global.fetch = mockFetch as any;
};

const teardownFetchMocks = () => {
  global.fetch = undefined as any;
};

const mockCtx = (secrets: Record<string, string | undefined> = {}): ToolContext => ({
  vault: {
    resolve: async (name: string) => {
      const key = name.replace(/^\$\{/, '').replace(/\}$/, '');
      const value = secrets[key];
      if (!value) throw new MissingSecretError(['KEY_NOT_FOUND']);
      return value;
    },
    writeSecret: async (key: string, value: string) => {
      secrets[key] = value;
    },
  },
} as any);

test('ThreadsClient constructor succeeds', () => {
  setupFetchMocks();
  const ctx = mockCtx();
  const client = new ThreadsClient(ctx);
  assert.ok(client);
  teardownFetchMocks();
});

test('post returns error when not authenticated', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = new ThreadsClient(ctx);

  const result = await client.post('Hello world');

  assert.equal(result.id, '');
  assert.ok(result.error);
  assert.ok(result.error.includes("isn't connected"));

  teardownFetchMocks();
});

test('post returns error when text is empty', async () => {
  setupFetchMocks();
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.post('');

  assert.equal(result.id, '');
  assert.ok(result.error);
  assert.ok(result.error.includes('required'));

  teardownFetchMocks();
});

test('post returns error when text exceeds 500 characters', async () => {
  setupFetchMocks();
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const longText = 'x'.repeat(501);
  const result = await client.post(longText);

  assert.equal(result.id, '');
  assert.ok(result.error);
  assert.ok(result.error.includes('500 character limit'));

  teardownFetchMocks();
});

test('post succeeds with valid text', async () => {
  setupFetchMocks();

  fetchResponses.set('https://graph.threads.com/v18.0/me/threads', {
    ok: true,
    json: async () => ({
      id: 'thread-123',
      thread_id: 'thread-123',
    }),
  } as any);

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.post('Hello Threads!');

  assert.equal(result.id, 'thread-123');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('post with reply_to includes reply_to_id', async () => {
  setupFetchMocks();

  fetchResponses.set('https://graph.threads.com/v18.0/me/threads', {
    ok: true,
    json: async () => ({
      id: 'thread-reply-123',
      thread_id: 'thread-reply-123',
    }),
  } as any);

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.post('Reply text', 'parent-thread-123');

  assert.equal(result.id, 'thread-reply-123');
  assert.equal(result.error, undefined);

  const postCall = fetchCalls.find((call) => call.url.includes('/me/threads'));
  assert.ok(postCall);
  const capturedBody = JSON.parse(postCall!.options!.body as string);
  assert.equal(capturedBody.reply_to_id, 'parent-thread-123');

  teardownFetchMocks();
});

test('post handles network error gracefully', async () => {
  setupFetchMocks();

  fetchResponses.set('https://graph.threads.com/v18.0/me/threads', new Error('Network error'));

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.post('Hello world');

  assert.equal(result.id, '');
  assert.ok(result.error);
  assert.ok(result.error.includes('Failed to post'));

  teardownFetchMocks();
});

test('search returns error when not authenticated', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = new ThreadsClient(ctx);

  const result = await client.search('test');

  assert.deepEqual(result.hashtags, []);
  assert.ok(result.error);
  assert.ok(result.error.includes("isn't connected"));

  teardownFetchMocks();
});

test('search returns error when query is empty', async () => {
  setupFetchMocks();
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.search('   ');

  assert.deepEqual(result.hashtags, []);
  assert.ok(result.error);
  assert.ok(result.error.includes('required'));

  teardownFetchMocks();
});

test('search succeeds with valid query', async () => {
  setupFetchMocks();

  fetchResponses.set(/graph\.threads\.com.*ig_hashtag_search/, {
    ok: true,
    json: async () => ({
      data: [
        {
          id: 'hashtag-123',
          name: 'threads',
        },
      ],
    }),
  } as any);

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.search('threads');

  assert.equal(result.hashtags.length, 1);
  assert.equal(result.hashtags[0].name, 'threads');
  assert.equal(result.hashtags[0].id, 'hashtag-123');
  assert.ok(result.hashtags[0].search_url.includes('threads'));
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('search respects limit parameter', async () => {
  setupFetchMocks();

  fetchResponses.set(/graph\.threads\.com.*ig_hashtag_search/, {
    ok: true,
    json: async () => ({
      data: [
        { id: 'tag1', name: 'threads' },
        { id: 'tag2', name: 'testing' },
        { id: 'tag3', name: 'ai' },
      ],
    }),
  } as any);

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.search('test', 2);

  assert.equal(result.hashtags.length, 2);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('search handles network error gracefully', async () => {
  setupFetchMocks();

  fetchResponses.set(/graph\.threads\.com.*ig_hashtag_search/, new Error('Network error'));

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.search('test');

  assert.deepEqual(result.hashtags, []);
  assert.ok(result.error);
  assert.ok(result.error.includes('Failed to search'));

  teardownFetchMocks();
});

test('getProfile returns error when not authenticated', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = new ThreadsClient(ctx);

  const result = await client.getProfile();

  assert.equal(result.user, null);
  assert.ok(result.error);
  assert.ok(result.error.includes("isn't connected"));

  teardownFetchMocks();
});

test('getProfile succeeds with valid token', async () => {
  setupFetchMocks();

  fetchResponses.set(/graph\.threads\.com.*\/me/, {
    ok: true,
    json: async () => ({
      data: {
        id: 'user-123',
        username: 'testuser',
        name: 'Test User',
        biography: 'Test bio',
        profile_picture_url: 'https://example.com/pic.jpg',
        follower_count: 1000,
        following_count: 500,
        is_verified: true,
        website: 'https://example.com',
      },
    }),
  } as any);

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.getProfile();

  assert.ok(result.user);
  assert.equal(result.user.username, 'testuser');
  assert.equal(result.user.follower_count, 1000);
  assert.equal(result.user.is_verified, true);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('getProfile handles network error gracefully', async () => {
  setupFetchMocks();

  fetchResponses.set(/graph\.threads\.com.*\/me/, new Error('Network error'));

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.getProfile();

  assert.equal(result.user, null);
  assert.ok(result.error);
  assert.ok(result.error.includes('Failed to get profile'));

  teardownFetchMocks();
});

test('getProfile caches result and prevents race conditions', async () => {
  setupFetchMocks();

  let callCount = 0;
  fetchResponses.set(/graph\.threads\.com.*\/me\?/, {
    ok: true,
    json: async () => {
      callCount++;
      return {
        data: {
          id: 'user-123',
          username: 'testuser',
          name: 'Test User',
          biography: 'Test bio',
          threads_profile_picture_url: 'https://example.com/pic.jpg',
          follower_count: 1000,
          following_count: 500,
          is_verified: true,
          website: 'https://example.com',
        },
      };
    },
  } as any);

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  // Call getProfile twice
  const result1 = await client.getProfile();
  const result2 = await client.getProfile();

  // Both should return the same cached result
  assert.ok(result1.user);
  assert.ok(result2.user);
  assert.equal(result1.user.id, result2.user.id);
  assert.equal(result1.user.username, result2.user.username);
  // Should only make 1 API call due to caching
  assert.equal(callCount, 1);

  teardownFetchMocks();
});

test('listTimeline returns error when not authenticated', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = new ThreadsClient(ctx);

  const result = await client.listTimeline();

  assert.deepEqual(result.posts, []);
  assert.ok(result.error);
  assert.ok(result.error.includes("isn't connected"));

  teardownFetchMocks();
});

test('listTimeline succeeds with valid token', async () => {
  setupFetchMocks();

  fetchResponses.set(/graph\.threads\.com.*\/me\/threads/, {
    ok: true,
    json: async () => ({
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
  } as any);

  fetchResponses.set(/graph\.threads\.com.*\/me\?/, {
    ok: true,
    json: async () => ({
      data: {
        id: 'user-123',
        username: 'testuser',
        name: 'Test User',
        biography: 'Test bio',
        threads_profile_picture_url: 'https://example.com/pic.jpg',
        follower_count: 1000,
        following_count: 500,
        is_verified: true,
        website: 'https://example.com',
      },
    }),
  } as any);

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.listTimeline();

  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].text, 'Hello Threads!');
  assert.equal(result.posts[0].like_count, 42);
  assert.equal(result.posts[0].author.id, 'user-123');
  assert.equal(result.posts[0].author.username, 'testuser');
  assert.equal(result.posts[0].author.name, 'Test User');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('listTimeline respects limit parameter', async () => {
  setupFetchMocks();

  fetchResponses.set(/graph\.threads\.com.*\/me\/threads/, {
    ok: true,
    json: async () => ({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: `post-${i}`,
        text: `Post ${i}`,
        timestamp: '2026-06-22T10:00:00Z',
        permalink: `https://threads.net/t/${i}`,
      })),
    }),
  } as any);

  fetchResponses.set(/graph\.threads\.com.*\/me\?/, {
    ok: true,
    json: async () => ({
      data: {
        id: 'user-123',
        username: 'testuser',
        name: 'Test User',
        biography: 'Test bio',
        threads_profile_picture_url: 'https://example.com/pic.jpg',
        follower_count: 1000,
        following_count: 500,
        is_verified: true,
        website: 'https://example.com',
      },
    }),
  } as any);

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.listTimeline(3);

  assert.equal(result.posts.length, 3);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('listTimeline handles network error gracefully', async () => {
  setupFetchMocks();

  fetchResponses.set(/graph\.threads\.com.*\/me\?/, {
    ok: true,
    json: async () => ({
      data: {
        id: 'user-123',
        username: 'testuser',
        name: 'Test User',
        biography: 'Test bio',
        threads_profile_picture_url: 'https://example.com/pic.jpg',
        follower_count: 1000,
        following_count: 500,
        is_verified: true,
        website: 'https://example.com',
      },
    }),
  } as any);

  fetchResponses.set(/graph\.threads\.com.*\/me\/threads/, new Error('Network error'));

  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });
  const client = new ThreadsClient(ctx);

  const result = await client.listTimeline();

  assert.deepEqual(result.posts, []);
  assert.ok(result.error);
  assert.ok(result.error.includes('Failed to list timeline'));

  teardownFetchMocks();
});
