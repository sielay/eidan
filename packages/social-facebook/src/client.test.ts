// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookClient } from './client.js';

let fetchCalls: Array<{ url: string; options: RequestInit | undefined }> = [];
let fetchResponses: Map<string, Response | Error> = new Map();

const mockFetch = (url: string | URL, options?: RequestInit): Response | Promise<Response> => {
  const urlStr = String(url);
  fetchCalls.push({ url: urlStr, options });

  const normalized = urlStr.split('?')[0] ?? '';
  for (const [key, response] of fetchResponses.entries()) {
    const keyStr = String(key);
    const keyNormalized = keyStr.split('?')[0] ?? '';
    if (keyNormalized === normalized) {
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }
  }

  return new Response(JSON.stringify({ error: { message: 'Not mocked' } }), {
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

test('postFeed returns success response', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://graph.facebook.com/v18.0/me/feed',
    new Response(JSON.stringify({ id: 'post-123' }), { status: 200 })
  );

  const client = new FacebookClient('test-token');
  const result = await client.postFeed('Test post');
  assert.equal(result.id, 'post-123');
  assert.equal(result.error, undefined);
  teardownFetchMocks();
});

test('postFeed returns error on API failure', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://graph.facebook.com/v18.0/me/feed',
    new Response(JSON.stringify({ error: { message: 'Invalid request' } }), { status: 400 })
  );

  const client = new FacebookClient('test-token');
  const result = await client.postFeed('Test post');
  assert.equal(result.id, '');
  assert.ok(result.error);
  teardownFetchMocks();
});

test('postFeed targets the page feed when a pageId is given', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://graph.facebook.com/v18.0/9999/feed',
    new Response(JSON.stringify({ id: 'post-page' }), { status: 200 })
  );

  const client = new FacebookClient('test-token', '9999');
  const result = await client.postFeed('Hello page');
  assert.equal(result.id, 'post-page');
  const postCall = fetchCalls.find((c) => c.options?.method === 'POST');
  assert.ok(postCall);
  assert.ok(postCall.url.includes('/9999/feed'));
  teardownFetchMocks();
});

test('getProfile returns user info', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://graph.facebook.com/v18.0/me',
    new Response(
      JSON.stringify({
        id: 'user-123',
        name: 'Test User',
        bio: 'Test bio',
        friends: { summary: { total_count: 42 } },
      }),
      { status: 200 }
    )
  );

  const client = new FacebookClient('test-token');
  const result = await client.getProfile();
  assert.equal(result.profile?.id, 'user-123');
  assert.equal(result.profile?.name, 'Test User');
  assert.equal(result.error, undefined);
  teardownFetchMocks();
});

test('getProfile returns error on failure', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://graph.facebook.com/v18.0/me',
    new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 })
  );

  const client = new FacebookClient('invalid-token');
  const result = await client.getProfile();
  assert.equal(result.profile, null);
  assert.ok(result.error);
  teardownFetchMocks();
});

test('listFeed returns posts', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://graph.facebook.com/v18.0/me/feed',
    new Response(
      JSON.stringify({
        data: [
          {
            id: 'post-1',
            message: 'First post',
            created_time: '2026-06-22T10:00:00Z',
            type: 'status',
            likes: { summary: { total_count: 5 } },
            comments: { summary: { total_count: 2 } },
          },
        ],
      }),
      { status: 200 }
    )
  );

  const client = new FacebookClient('test-token');
  const result = await client.listFeed(10);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]?.id, 'post-1');
  assert.equal(result.error, undefined);
  teardownFetchMocks();
});

test('search returns posts', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://graph.facebook.com/v18.0/search',
    new Response(
      JSON.stringify({
        data: [
          {
            id: 'post-1',
            name: 'Found post',
            type: 'post',
          },
        ],
      }),
      { status: 200 }
    )
  );

  const client = new FacebookClient('test-token');
  const result = await client.search('test query');
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]?.id, 'post-1');
  assert.equal(result.error, undefined);
  teardownFetchMocks();
});

test('postFeed with image_url includes URL in request', async () => {
  setupFetchMocks();
  fetchResponses.set(
    'https://graph.facebook.com/v18.0/me/feed',
    new Response(JSON.stringify({ id: 'post-456' }), { status: 200 })
  );

  const client = new FacebookClient('test-token');
  const result = await client.postFeed('Test post', 'https://example.com/image.jpg');
  assert.equal(result.id, 'post-456');

  const postCall = fetchCalls.find((c) => c.options?.method === 'POST');
  assert.ok(postCall);
  assert.ok(String(postCall.options?.body).includes('url='));
  teardownFetchMocks();
});
