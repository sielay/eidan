// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MastodonClient } from './client.js';
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
    const keyStr = String(key);
    const basePart = keyStr.split('?')[0] || '';
    if (urlStr.includes(basePart) && keyStr.includes('?')) {
      const keyUrl = new URL(keyStr);
      const givenUrl = new URL(urlStr);
      let matches = true;
      for (const [param, value] of keyUrl.searchParams.entries()) {
        if (givenUrl.searchParams.get(param) !== value) {
          matches = false;
          break;
        }
      }
      if (matches) {
        if (response instanceof Error) {
          throw response;
        }
        return response;
      }
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
      if (value === undefined) {
        throw new MissingSecretError([key]);
      }
      return value;
    },
    writeSecret: async () => {},
  },
  tools: { call: async () => ({ type: 'error', message: 'mock' }) },
  emit: async () => {},
});

test('MastodonClient.create - returns null when secrets missing', async () => {
  setupFetchMocks();
  const ctx = mockCtx({});
  const client = await MastodonClient.create(ctx);
  assert.equal(client, null);
  teardownFetchMocks();
});

test('MastodonClient.create - creates client with valid secrets', async () => {
  setupFetchMocks();
  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);
  teardownFetchMocks();
});

test('MastodonClient.create - normalizes instance URL', async () => {
  setupFetchMocks();
  const ctx = mockCtx({
    MASTODON_INSTANCE: 'https://mastodon.social/',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);
  teardownFetchMocks();
});

test('post - posts successfully', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/statuses', {
    ok: true,
    status: 200,
    json: async () => ({ id: '123', url: 'https://mastodon.social/@user/123' }),
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.post('Hello Mastodon!');
  assert.equal(result.id, '123');
  assert.equal(result.url, 'https://mastodon.social/@user/123');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('post - handles API error', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/statuses', {
    ok: false,
    status: 401,
    text: async () => 'Unauthorized',
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'invalid-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.post('Hello Mastodon!');
  assert.ok(result.error);
  assert.match(result.error, /Failed to post/);

  teardownFetchMocks();
});

test('post - supports visibility parameter', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/statuses', {
    ok: true,
    status: 200,
    json: async () => ({ id: '456', url: 'https://mastodon.social/@user/456' }),
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.post('Private message', { visibility: 'private' });
  assert.equal(result.id, '456');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('post - supports reply_to parameter', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/statuses', {
    ok: true,
    status: 200,
    json: async () => ({ id: '789', url: 'https://mastodon.social/@user/789' }),
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.post('Reply text', { replyTo: '456' });
  assert.equal(result.id, '789');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('search - returns matching statuses', async () => {
  setupFetchMocks();
  const searchUrl = 'https://mastodon.social/api/v2/search?q=test&type=statuses&limit=20';
  fetchResponses.set(searchUrl, {
    ok: true,
    status: 200,
    json: async () => ({
      statuses: [
        {
          id: '1',
          content: 'Test post',
          created_at: '2026-01-01T00:00:00Z',
          url: 'https://mastodon.social/@user/1',
          account: { acct: 'user', username: 'user', display_name: 'User' },
          favourites_count: 10,
          replies_count: 2,
          reblogs_count: 5,
        },
      ],
    }),
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.search('test');
  assert.ok(result.statuses);
  assert.equal(result.statuses!.length, 1);
  assert.equal(result.statuses![0].id, '1');
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('search - handles API error', async () => {
  setupFetchMocks();
  const searchUrl = 'https://mastodon.social/api/v2/search?q=test&type=statuses&limit=20';
  fetchResponses.set(searchUrl, {
    ok: false,
    status: 503,
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.search('test');
  assert.ok(result.error);
  assert.match(result.error, /Search failed/);

  teardownFetchMocks();
});

test('getProfile - fetches own profile', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/accounts/verify_credentials', {
    ok: true,
    status: 200,
    json: async () => ({ id: 'user-id', acct: 'user', username: 'user', display_name: 'User' }),
  } as any);
  fetchResponses.set('https://mastodon.social/api/v1/accounts/user-id', {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'user-id',
      acct: 'user',
      username: 'user',
      display_name: 'User',
      note: 'Bio',
      followers_count: 100,
      following_count: 50,
      statuses_count: 200,
      avatar: 'https://example.com/avatar.jpg',
      url: 'https://mastodon.social/@user',
      created_at: '2020-01-01T00:00:00Z',
    }),
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.getProfile();
  assert.ok(result.account);
  assert.equal(result.account!.acct, 'user');
  assert.equal(result.account!.followers_count, 100);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('getProfile - fetches other account by ID', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/accounts/other-id', {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'other-id',
      acct: 'other',
      username: 'other',
      display_name: 'Other User',
      note: 'Other bio',
      followers_count: 500,
      following_count: 200,
      statuses_count: 1000,
      avatar: 'https://example.com/avatar2.jpg',
      url: 'https://mastodon.social/@other',
      created_at: '2019-01-01T00:00:00Z',
    }),
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.getProfile('other-id');
  assert.ok(result.account);
  assert.equal(result.account!.acct, 'other');
  assert.equal(result.account!.followers_count, 500);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('getTimeline - fetches home timeline', async () => {
  setupFetchMocks();
  const timelineUrl = 'https://mastodon.social/api/v1/timelines/home?limit=20';
  fetchResponses.set(timelineUrl, {
    ok: true,
    status: 200,
    json: async () => [
      {
        id: '1',
        content: 'Timeline post',
        created_at: '2026-01-01T00:00:00Z',
        url: 'https://mastodon.social/@user/1',
        account: { acct: 'user', username: 'user', display_name: 'User' },
        favourites_count: 10,
        replies_count: 2,
        reblogs_count: 5,
      },
    ],
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.getTimeline('home', 20);
  assert.ok(result.statuses);
  assert.equal(result.statuses!.length, 1);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('getTimeline - fetches local timeline', async () => {
  setupFetchMocks();
  const timelineUrl = 'https://mastodon.social/api/v1/timelines/public?local=true&limit=20';
  fetchResponses.set(timelineUrl, {
    ok: true,
    status: 200,
    json: async () => [
      {
        id: '2',
        content: 'Local post',
        created_at: '2026-01-01T00:00:00Z',
        url: 'https://mastodon.social/@local/2',
        account: { acct: 'local', username: 'local', display_name: 'Local User' },
        favourites_count: 5,
        replies_count: 1,
        reblogs_count: 2,
      },
    ],
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const result = await client!.getTimeline('local', 20);
  assert.ok(result.statuses);
  assert.equal(result.statuses!.length, 1);
  assert.equal(result.error, undefined);

  teardownFetchMocks();
});

test('verifyCredentials - returns account on success', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/accounts/verify_credentials', {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'user-id',
      acct: 'user',
      username: 'user',
      display_name: 'User',
      note: 'Bio',
      followers_count: 100,
      following_count: 50,
      statuses_count: 200,
      avatar: 'https://example.com/avatar.jpg',
      url: 'https://mastodon.social/@user',
      created_at: '2020-01-01T00:00:00Z',
    }),
  } as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const account = await client!.verifyCredentials();
  assert.ok(account);
  assert.equal(account!.acct, 'user');

  teardownFetchMocks();
});

test('verifyCredentials - returns null on error', async () => {
  setupFetchMocks();
  const mockResponse: Partial<Response> = {
    ok: false,
    status: 401,
  };
  fetchResponses.set('https://mastodon.social/api/v1/accounts/verify_credentials', mockResponse as any);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'invalid-token',
  });
  const client = await MastodonClient.create(ctx);
  assert.ok(client);

  const account = await client!.verifyCredentials();
  assert.equal(account, null);

  teardownFetchMocks();
});
