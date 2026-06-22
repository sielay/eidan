// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFacebookTools } from './tools.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

const setupFetchMocks = () => {
  global.fetch = ((_url: string | URL, _options?: RequestInit) => {
    return new Response(JSON.stringify({ error: { message: 'Not mocked' } }), {
      status: 404,
    });
  }) as any;
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
    writeSecret: async () => {},
  },
} as any);

test('makeFacebookTools returns 4 tools', () => {
  const tools = makeFacebookTools();
  assert.equal(tools.length, 4);
  assert.equal(tools[0]?.name, 'facebook_post_feed');
  assert.equal(tools[1]?.name, 'facebook_search');
  assert.equal(tools[2]?.name, 'facebook_get_profile');
  assert.equal(tools[3]?.name, 'facebook_list_feed');
});

test('facebook_post_feed tool has correct schema', () => {
  const tools = makeFacebookTools();
  const postTool = tools.find((t) => t.name === 'facebook_post_feed');
  assert.ok(postTool);
  const schema = postTool?.inputSchema as any;
  assert.equal(schema.required[0], 'text');
  assert.ok(schema.properties.text);
  assert.ok(schema.properties.image_url);
});

test('facebook_search tool has correct schema', () => {
  const tools = makeFacebookTools();
  const searchTool = tools.find((t) => t.name === 'facebook_search');
  assert.ok(searchTool);
  const schema = searchTool?.inputSchema as any;
  assert.equal(schema.required[0], 'query');
  assert.ok(schema.properties.query);
  assert.ok(schema.properties.limit);
});

test('facebook_get_profile tool has correct schema', () => {
  const tools = makeFacebookTools();
  const profileTool = tools.find((t) => t.name === 'facebook_get_profile');
  assert.ok(profileTool);
  assert.ok(profileTool?.inputSchema);
});

test('facebook_list_feed tool has correct schema', () => {
  const tools = makeFacebookTools();
  const feedTool = tools.find((t) => t.name === 'facebook_list_feed');
  assert.ok(feedTool);
  const schema = feedTool?.inputSchema as any;
  assert.ok(schema.properties.limit);
});

test('facebook_post_feed yields error when text is empty', async () => {
  setupFetchMocks();
  const tools = makeFacebookTools();
  const postTool = tools.find((t) => t.name === 'facebook_post_feed');
  const ctx = mockCtx({ FACEBOOK_ACCESS_TOKEN: 'token' });

  const results: any[] = [];
  for await (const result of postTool!.executor.execute({ text: '' }, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0]?.type, 'error');
  teardownFetchMocks();
});

test('facebook_post_feed yields error when token missing', async () => {
  setupFetchMocks();
  const tools = makeFacebookTools();
  const postTool = tools.find((t) => t.name === 'facebook_post_feed');
  const ctx = mockCtx({});

  const results: any[] = [];
  for await (const result of postTool!.executor.execute({ text: 'Hello' }, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0]?.type, 'error');
  assert.ok(results[0]?.message?.includes('Facebook isn\'t connected'));
  teardownFetchMocks();
});

test('facebook_search yields error when query is empty', async () => {
  setupFetchMocks();
  const tools = makeFacebookTools();
  const searchTool = tools.find((t) => t.name === 'facebook_search');
  const ctx = mockCtx({ FACEBOOK_ACCESS_TOKEN: 'token' });

  const results: any[] = [];
  for await (const result of searchTool!.executor.execute({ query: '' }, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0]?.type, 'error');
  teardownFetchMocks();
});

test('facebook_search yields error when token missing', async () => {
  setupFetchMocks();
  const tools = makeFacebookTools();
  const searchTool = tools.find((t) => t.name === 'facebook_search');
  const ctx = mockCtx({});

  const results: any[] = [];
  for await (const result of searchTool!.executor.execute({ query: 'test' }, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0]?.type, 'error');
  teardownFetchMocks();
});

test('facebook_get_profile yields error when token missing', async () => {
  setupFetchMocks();
  const tools = makeFacebookTools();
  const profileTool = tools.find((t) => t.name === 'facebook_get_profile');
  const ctx = mockCtx({});

  const results: any[] = [];
  for await (const result of profileTool!.executor.execute({}, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0]?.type, 'error');
  teardownFetchMocks();
});

test('facebook_list_feed yields error when token missing', async () => {
  setupFetchMocks();
  const tools = makeFacebookTools();
  const feedTool = tools.find((t) => t.name === 'facebook_list_feed');
  const ctx = mockCtx({});

  const results: any[] = [];
  for await (const result of feedTool!.executor.execute({ limit: 10 }, ctx)) {
    results.push(result);
  }

  assert.equal(results.length, 1);
  assert.equal(results[0]?.type, 'error');
  teardownFetchMocks();
});
