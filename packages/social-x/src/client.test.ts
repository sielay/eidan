// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'assert';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { XClient, createXClient } from './client.js';

export async function testXClientPostTweet() {
  const mockCtx = {} as ToolContext;
  const client = new XClient(mockCtx, 'test-token');

  const originalFetch = global.fetch;
  let fetchCalled = false;

  global.fetch = async (url: string, options?: RequestInit) => {
    fetchCalled = true;
    assert(url.includes('/tweets'));
    assert((options?.headers as Record<string, string>)?.Authorization === 'Bearer test-token');

    return {
      ok: true,
      json: async () => ({
        data: {
          id: '1234567890',
          text: 'Hello, X!',
        },
      }),
    } as Response;
  };

  const result = await client.postTweet('Hello, X!');
  assert(fetchCalled);
  assert.strictEqual(result.tweetId, '1234567890');
  assert.strictEqual(result.text, 'Hello, X!');
  assert.strictEqual(result.error, undefined);

  global.fetch = originalFetch;
}

export async function testXClientPostTweetTooLong() {
  const mockCtx = {} as ToolContext;
  const client = new XClient(mockCtx, 'test-token');

  const text = 'a'.repeat(281);
  const result = await client.postTweet(text);

  assert.strictEqual(result.tweetId, '');
  assert(result.error?.includes('280'));
}

export async function testXClientGetMe() {
  const mockCtx = {} as ToolContext;
  const client = new XClient(mockCtx, 'test-token');

  const originalFetch = global.fetch;
  let fetchCalled = false;

  global.fetch = async (url: string) => {
    fetchCalled = true;
    assert(url.includes('/users/me'));

    return {
      ok: true,
      json: async () => ({
        data: {
          id: '12345',
          name: 'Test User',
          username: 'testuser',
          followers_count: 100,
          verified: false,
        },
      }),
    } as Response;
  };

  const result = await client.getMe();
  assert(fetchCalled);
  assert.strictEqual(result.profile?.username, 'testuser');
  assert.strictEqual(result.profile?.followers_count, 100);
  assert.strictEqual(result.error, undefined);

  global.fetch = originalFetch;
}

export async function testXClientSearchTweets() {
  const mockCtx = {} as ToolContext;
  const client = new XClient(mockCtx, 'test-token');

  const originalFetch = global.fetch;
  let fetchCalled = false;

  global.fetch = async (url: string) => {
    fetchCalled = true;
    assert(url.includes('/tweets/search/recent'));
    assert(url.includes('query=test'));

    return {
      ok: true,
      json: async () => ({
        data: [
          {
            id: '67890',
            text: 'Test tweet',
            author_id: '12345',
            public_metrics: {
              like_count: 10,
              reply_count: 2,
              retweet_count: 5,
            },
          },
        ],
      }),
    } as Response;
  };

  const result = await client.searchTweets('test', 20);
  assert(fetchCalled);
  assert.strictEqual(result.tweets.length, 1);
  assert.strictEqual(result.tweets[0]?.text, 'Test tweet');
  assert.strictEqual(result.error, undefined);

  global.fetch = originalFetch;
}

export async function testCreateXClientMissingToken() {
  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError('Secret not found');
      },
    },
  } as unknown as ToolContext;

  const result = await createXClient(mockCtx);
  assert.strictEqual(result.client, null);
  assert(result.error?.includes('X_ACCESS_TOKEN'));
}

export async function testCreateXClientWithToken() {
  const mockCtx = {
    vault: {
      resolve: async () => 'test-token',
    },
  } as unknown as ToolContext;

  const result = await createXClient(mockCtx);
  assert(result.client !== null);
  assert.strictEqual(result.error, undefined);
}
