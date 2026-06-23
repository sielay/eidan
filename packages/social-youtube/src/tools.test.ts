// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import * as assert from 'node:assert';
import { makeYouTubeTools } from './tools.js';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

test('youtube tools: all tools are registered', () => {
  const tools = makeYouTubeTools();
  assert.strictEqual(tools.length, 4);
  assert.deepStrictEqual(
    tools.map((t) => t.name),
    ['youtube_post_comment', 'youtube_search', 'youtube_get_channel', 'youtube_list_videos']
  );
});

test('youtube_post_comment: has complete JSON schema', () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_post_comment');
  assert.ok(tool);
  assert.strictEqual(tool.inputSchema.type, 'object');
  assert.deepStrictEqual(tool.inputSchema.required, ['video_id', 'text']);
  assert.ok(tool.inputSchema.properties.video_id);
  assert.ok(tool.inputSchema.properties.text);
});

test('youtube_search: has complete JSON schema', () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_search');
  assert.ok(tool);
  assert.strictEqual(tool.inputSchema.type, 'object');
  assert.deepStrictEqual(tool.inputSchema.required, ['query']);
  assert.ok(tool.inputSchema.properties.query);
  assert.ok(tool.inputSchema.properties.limit);
});

test('youtube_get_channel: has complete JSON schema', () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_get_channel');
  assert.ok(tool);
  assert.strictEqual(tool.inputSchema.type, 'object');
  assert.deepStrictEqual(tool.inputSchema.required, []);
});

test('youtube_list_videos: has complete JSON schema', () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_list_videos');
  assert.ok(tool);
  assert.strictEqual(tool.inputSchema.type, 'object');
  assert.ok(tool.inputSchema.properties.limit);
});

test('youtube_post_comment: executor yields error when token is missing', async () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_post_comment');
  assert.ok(tool);

  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['YOUTUBE_ACCESS_TOKEN']);
      },
    },
  } as any;

  const executor = tool.executor!;
  const results: any[] = [];
  for await (const result of executor.execute({ video_id: 'vid123', text: 'test' }, mockCtx)) {
    results.push(result);
  }

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'error');
  assert.match(results[0].message, /YouTube not connected/);
});

test('youtube_post_comment: executor yields error when inputs are missing', async () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_post_comment');
  assert.ok(tool);

  const mockCtx = {} as any;

  const executor = tool.executor!;
  const results: any[] = [];
  for await (const result of executor.execute({}, mockCtx)) {
    results.push(result);
  }

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'error');
  assert.match(results[0].message, /required/i);
});

test('youtube_search: executor yields error when query is missing', async () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_search');
  assert.ok(tool);

  const mockCtx = {} as any;

  const executor = tool.executor!;
  const results: any[] = [];
  for await (const result of executor.execute({}, mockCtx)) {
    results.push(result);
  }

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'error');
  assert.match(results[0].message, /query is required/);
});

test('youtube_get_channel: executor yields error when token is missing', async () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_get_channel');
  assert.ok(tool);

  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['YOUTUBE_ACCESS_TOKEN']);
      },
    },
  } as any;

  const executor = tool.executor!;
  const results: any[] = [];
  for await (const result of executor.execute({}, mockCtx)) {
    results.push(result);
  }

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'error');
});

test('youtube_list_videos: executor yields error when token is missing', async () => {
  const tools = makeYouTubeTools();
  const tool = tools.find((t) => t.name === 'youtube_list_videos');
  assert.ok(tool);

  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['YOUTUBE_ACCESS_TOKEN']);
      },
    },
  } as any;

  const executor = tool.executor!;
  const results: any[] = [];
  for await (const result of executor.execute({}, mockCtx)) {
    results.push(result);
  }

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'error');
});
