// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMastodonTools } from './tools.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

let fetchResponses: Map<string, Response | Error> = new Map();

const mockFetch = (url: string | URL, options?: RequestInit): Response | Promise<Response> => {
  const urlStr = String(url);

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
        throw new MissingSecretError(key);
      }
      return value;
    },
    writeSecret: async () => {},
  },
  tools: { call: async () => ({ type: 'error', message: 'mock' }) },
  emit: async () => {},
});

const collectResults = async (generator: AsyncGenerator<any>): Promise<any[]> => {
  const results: any[] = [];
  for await (const result of generator) {
    results.push(result);
  }
  return results;
};

test('mastodon_post - posts successfully', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/statuses', {
    ok: true,
    status: 200,
    json: async () => ({ id: '123', url: 'https://mastodon.social/@user/123' }),
  } as any);

  const tools = makeMastodonTools();
  const postTool = tools.find((t) => t.name === 'mastodon_post');
  assert.ok(postTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(postTool!.executor.execute!({ text: 'Hello!' }, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.id, '123');
  assert.equal(results[0].value.text, 'Hello!');

  teardownFetchMocks();
});

test('mastodon_post - yields error when text is empty', async () => {
  setupFetchMocks();
  const tools = makeMastodonTools();
  const postTool = tools.find((t) => t.name === 'mastodon_post');
  assert.ok(postTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(postTool!.executor.execute!({ text: '' }, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.match(results[0].message, /text is required/);

  teardownFetchMocks();
});

test('mastodon_post - yields error when secrets missing', async () => {
  setupFetchMocks();
  const tools = makeMastodonTools();
  const postTool = tools.find((t) => t.name === 'mastodon_post');
  assert.ok(postTool);

  const ctx = mockCtx({});

  const results = await collectResults(postTool!.executor.execute!({ text: 'Hello!' }, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.match(results[0].message, /Mastodon isn't connected/);

  teardownFetchMocks();
});

test('mastodon_post - supports visibility parameter', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/statuses', {
    ok: true,
    status: 200,
    json: async () => ({ id: '456', url: 'https://mastodon.social/@user/456' }),
  } as any);

  const tools = makeMastodonTools();
  const postTool = tools.find((t) => t.name === 'mastodon_post');
  assert.ok(postTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(
    postTool!.executor.execute!({ text: 'Private!', visibility: 'private' }, ctx)
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.visibility, 'private');

  teardownFetchMocks();
});

test('mastodon_search - searches successfully', async () => {
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

  const tools = makeMastodonTools();
  const searchTool = tools.find((t) => t.name === 'mastodon_search');
  assert.ok(searchTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(searchTool!.executor.execute!({ query: 'test' }, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.toots.length, 1);
  assert.equal(results[0].value.count, 1);

  teardownFetchMocks();
});

test('mastodon_search - yields error when query is empty', async () => {
  setupFetchMocks();
  const tools = makeMastodonTools();
  const searchTool = tools.find((t) => t.name === 'mastodon_search');
  assert.ok(searchTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(searchTool!.executor.execute!({ query: '' }, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.match(results[0].message, /query is required/);

  teardownFetchMocks();
});

test('mastodon_get_profile - gets own profile', async () => {
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
      note: '<p>My bio</p>',
      followers_count: 100,
      following_count: 50,
      statuses_count: 200,
      avatar: 'https://example.com/avatar.jpg',
      url: 'https://mastodon.social/@user',
      created_at: '2020-01-01T00:00:00Z',
    }),
  } as any);

  const tools = makeMastodonTools();
  const profileTool = tools.find((t) => t.name === 'mastodon_get_profile');
  assert.ok(profileTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(profileTool!.executor.execute!({}, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.username, 'user');
  assert.equal(results[0].value.followers, 100);

  teardownFetchMocks();
});

test('mastodon_get_profile - gets other profile by ID', async () => {
  setupFetchMocks();
  fetchResponses.set('https://mastodon.social/api/v1/accounts/other-id', {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'other-id',
      acct: 'other',
      username: 'other',
      display_name: 'Other',
      note: 'Other bio',
      followers_count: 500,
      following_count: 200,
      statuses_count: 1000,
      avatar: 'https://example.com/avatar2.jpg',
      url: 'https://mastodon.social/@other',
      created_at: '2019-01-01T00:00:00Z',
    }),
  } as any);

  const tools = makeMastodonTools();
  const profileTool = tools.find((t) => t.name === 'mastodon_get_profile');
  assert.ok(profileTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(profileTool!.executor.execute!({ account_id: 'other-id' }, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.username, 'other');
  assert.equal(results[0].value.followers, 500);

  teardownFetchMocks();
});

test('mastodon_list_timeline - lists home timeline', async () => {
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

  const tools = makeMastodonTools();
  const timelineTool = tools.find((t) => t.name === 'mastodon_list_timeline');
  assert.ok(timelineTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(timelineTool!.executor.execute!({}, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.timeline_type, 'home');
  assert.equal(results[0].value.toots.length, 1);

  teardownFetchMocks();
});

test('mastodon_list_timeline - lists local timeline', async () => {
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

  const tools = makeMastodonTools();
  const timelineTool = tools.find((t) => t.name === 'mastodon_list_timeline');
  assert.ok(timelineTool);

  const ctx = mockCtx({
    MASTODON_INSTANCE: 'mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token',
  });

  const results = await collectResults(timelineTool!.executor.execute!({ timeline_type: 'local' }, ctx));
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.equal(results[0].value.timeline_type, 'local');
  assert.equal(results[0].value.toots.length, 1);

  teardownFetchMocks();
});

test('tools have correct schemas', async () => {
  const tools = makeMastodonTools();

  const postTool = tools.find((t) => t.name === 'mastodon_post');
  assert.ok(postTool);
  assert.ok(postTool.inputSchema);
  assert.deepEqual(postTool.inputSchema.required, ['text']);

  const searchTool = tools.find((t) => t.name === 'mastodon_search');
  assert.ok(searchTool);
  assert.ok(searchTool.inputSchema);
  assert.deepEqual(searchTool.inputSchema.required, ['query']);

  const profileTool = tools.find((t) => t.name === 'mastodon_get_profile');
  assert.ok(profileTool);
  assert.ok(profileTool.inputSchema);

  const timelineTool = tools.find((t) => t.name === 'mastodon_list_timeline');
  assert.ok(timelineTool);
  assert.ok(timelineTool.inputSchema);
});
