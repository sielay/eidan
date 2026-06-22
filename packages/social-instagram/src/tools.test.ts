// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeInstagramTools } from './tools.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

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

const collectYields = async (generator: AsyncIterable<any>): Promise<Array<any>> => {
  const results: Array<any> = [];
  for await (const item of generator) {
    results.push(item);
  }
  return results;
};

test('makeInstagramTools returns four tools', () => {
  const tools = makeInstagramTools();
  assert.equal(tools.length, 4);

  const names = tools.map((t) => t.name);
  assert.ok(names.includes('instagram_post_feed'));
  assert.ok(names.includes('instagram_search'));
  assert.ok(names.includes('instagram_get_profile'));
  assert.ok(names.includes('instagram_list_feed'));
});

test('instagram_post_feed tool has correct schema', () => {
  const tools = makeInstagramTools();
  const postTool = tools.find((t) => t.name === 'instagram_post_feed');

  assert.ok(postTool);
  const schema = postTool?.inputSchema as any;
  assert.equal(schema.type, 'object');
  assert.ok(schema.required.includes('text'));
  assert.ok(schema.required.includes('image_url'));
  assert.ok(schema.properties.text);
  assert.ok(schema.properties.image_url);
});

test('instagram_search tool has correct schema', () => {
  const tools = makeInstagramTools();
  const searchTool = tools.find((t) => t.name === 'instagram_search');

  assert.ok(searchTool);
  const schema = searchTool?.inputSchema as any;
  assert.equal(schema.type, 'object');
  assert.ok(schema.required.includes('query'));
  assert.ok(schema.properties.query);
  assert.ok(schema.properties.limit);
});

test('instagram_get_profile tool has correct schema', () => {
  const tools = makeInstagramTools();
  const profileTool = tools.find((t) => t.name === 'instagram_get_profile');

  assert.ok(profileTool);
  const schema = profileTool?.inputSchema as any;
  assert.equal(schema.type, 'object');
});

test('instagram_list_feed tool has correct schema', () => {
  const tools = makeInstagramTools();
  const feedTool = tools.find((t) => t.name === 'instagram_list_feed');

  assert.ok(feedTool);
  const schema = feedTool?.inputSchema as any;
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties.limit);
});

test('instagram_post_feed executor yields error without text', async () => {
  const tools = makeInstagramTools();
  const postTool = tools.find((t) => t.name === 'instagram_post_feed');
  const ctx = mockCtx();

  const results = await collectYields(
    postTool!.executor.execute({ image_url: 'https://example.com/image.jpg' }, ctx)
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes('text is required'));
});

test('instagram_post_feed executor yields error without image_url', async () => {
  const tools = makeInstagramTools();
  const postTool = tools.find((t) => t.name === 'instagram_post_feed');
  const ctx = mockCtx();

  const results = await collectYields(postTool!.executor.execute({ text: 'Test post' }, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes('image_url is required'));
});

test('instagram_search executor yields error without query', async () => {
  const tools = makeInstagramTools();
  const searchTool = tools.find((t) => t.name === 'instagram_search');
  const ctx = mockCtx();

  const results = await collectYields(searchTool!.executor.execute({}, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes('query is required'));
});

test('instagram_get_profile executor yields error when not authenticated', async () => {
  const tools = makeInstagramTools();
  const profileTool = tools.find((t) => t.name === 'instagram_get_profile');
  const ctx = mockCtx({});

  const results = await collectYields(profileTool!.executor.execute({}, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'error');
  assert.ok(results[0].message.includes("isn't connected"));
});

test('instagram_list_feed executor handles missing token gracefully', async () => {
  const tools = makeInstagramTools();
  const feedTool = tools.find((t) => t.name === 'instagram_list_feed');
  const ctx = mockCtx({});

  const results = await collectYields(feedTool!.executor.execute({}, ctx));

  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'result');
  assert.deepEqual(results[0].value.posts, []);
  assert.equal(results[0].value.count, 0);
});
