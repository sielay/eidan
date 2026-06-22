// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeThreadsTools } from './tools.js';
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
    if (urlStr.includes(keyStr.split('?')[0] || '')) {
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

test('makeThreadsTools returns all four tools', () => {
  const tools = makeThreadsTools();
  assert.equal(tools.length, 4);
  assert.equal(tools[0].name, 'threads_post_thread');
  assert.equal(tools[1].name, 'threads_search');
  assert.equal(tools[2].name, 'threads_get_profile');
  assert.equal(tools[3].name, 'threads_list_timeline');
});

test('threads_post_thread has correct schema', () => {
  const tools = makeThreadsTools();
  const postTool = tools.find((t) => t.name === 'threads_post_thread');
  assert.ok(postTool);
  assert.ok(postTool.inputSchema);
  const schema = postTool.inputSchema as any;
  assert.equal(schema.required?.[0], 'text');
  assert.ok(schema.properties?.text);
  assert.ok(schema.properties?.reply_to);
});

test('threads_search has correct schema', () => {
  const tools = makeThreadsTools();
  const searchTool = tools.find((t) => t.name === 'threads_search');
  assert.ok(searchTool);
  assert.ok(searchTool.inputSchema);
  const schema = searchTool.inputSchema as any;
  assert.equal(schema.required?.[0], 'query');
  assert.ok(schema.properties?.query);
  assert.ok(schema.properties?.limit);
});

test('threads_get_profile has correct schema', () => {
  const tools = makeThreadsTools();
  const profileTool = tools.find((t) => t.name === 'threads_get_profile');
  assert.ok(profileTool);
  assert.ok(profileTool.inputSchema);
  const schema = profileTool.inputSchema as any;
  assert.deepEqual(schema.properties, {});
});

test('threads_list_timeline has correct schema', () => {
  const tools = makeThreadsTools();
  const timelineTool = tools.find((t) => t.name === 'threads_list_timeline');
  assert.ok(timelineTool);
  assert.ok(timelineTool.inputSchema);
  const schema = timelineTool.inputSchema as any;
  assert.ok(schema.properties?.limit);
});

test('threads_post_thread yields error when text is missing', async () => {
  setupFetchMocks();
  const tools = makeThreadsTools();
  const postTool = tools[0];
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });

  const results = [];
  for await (const result of postTool.executor.execute({} as any, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok((results[0] as any).message.includes('required'));

  teardownFetchMocks();
});

test('threads_post_thread yields result on success', async () => {
  setupFetchMocks();

  fetchResponses.set('https://graph.threads.com/v18.0/me/threads', {
    ok: true,
    json: async () => ({ id: 'thread-123' }),
  } as any);

  const tools = makeThreadsTools();
  const postTool = tools[0];
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });

  const results = [];
  for await (const result of postTool.executor.execute(
    { text: 'Hello' } as any,
    ctx
  )) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  const value = (results[0] as any).value;
  assert.equal(value.id, 'thread-123');
  assert.ok(value.message.includes('Posted to Threads'));

  teardownFetchMocks();
});

test('threads_search yields error when query is missing', async () => {
  setupFetchMocks();
  const tools = makeThreadsTools();
  const searchTool = tools[1];
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });

  const results = [];
  for await (const result of searchTool.executor.execute({} as any, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');

  teardownFetchMocks();
});

test('threads_search yields result on success', async () => {
  setupFetchMocks();

  fetchResponses.set('https://graph.threads.com/v18.0/ig_hashtag_search', {
    ok: true,
    json: async () => ({
      data: [
        {
          id: 'tag-1',
          name: 'threads',
        },
      ],
    }),
  } as any);

  const tools = makeThreadsTools();
  const searchTool = tools[1];
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });

  const results = [];
  for await (const result of searchTool.executor.execute(
    { query: 'threads' } as any,
    ctx
  )) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  const value = (results[0] as any).value;
  assert.equal(value.count, 1);
  assert.equal(value.posts[0].author, 'threads');

  teardownFetchMocks();
});

test('threads_get_profile yields result on success', async () => {
  setupFetchMocks();

  fetchResponses.set('https://graph.threads.com/v18.0/me', {
    ok: true,
    json: async () => ({
      data: {
        id: 'user-123',
        username: 'testuser',
        name: 'Test User',
        biography: 'My bio',
        follower_count: 500,
        following_count: 100,
        is_verified: true,
        website: 'https://example.com',
      },
    }),
  } as any);

  const tools = makeThreadsTools();
  const profileTool = tools[2];
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });

  const results = [];
  for await (const result of profileTool.executor.execute({} as any, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  const value = (results[0] as any).value;
  assert.equal(value.username, 'testuser');
  assert.equal(value.followers, 500);
  assert.equal(value.verified, true);

  teardownFetchMocks();
});

test('threads_list_timeline yields result on success', async () => {
  setupFetchMocks();

  fetchResponses.set('https://graph.threads.com/v18.0/me/threads', {
    ok: true,
    json: async () => ({
      data: [
        {
          id: 'post-1',
          text: 'Hello',
          timestamp: '2026-06-22T10:00:00Z',
          permalink: 'https://threads.net/t/1',
          like_count: 10,
          reply_count: 2,
        },
      ],
    }),
  } as any);

  const tools = makeThreadsTools();
  const timelineTool = tools[3];
  const ctx = mockCtx({ THREADS_ACCESS_TOKEN: 'token123' });

  const results = [];
  for await (const result of timelineTool.executor.execute(
    { limit: 20 } as any,
    ctx
  )) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  const value = (results[0] as any).value;
  assert.equal(value.count, 1);
  assert.equal(value.posts[0].text, 'Hello');
  assert.equal(value.posts[0].likes, 10);

  teardownFetchMocks();
});
