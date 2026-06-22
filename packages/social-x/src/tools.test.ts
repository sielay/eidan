// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'assert';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeXTools } from './tools.js';

export async function testMakeXToolsReturnsAllTools() {
  const tools = makeXTools();
  assert.strictEqual(tools.length, 4);

  const toolNames = tools.map((t) => t.name);
  assert(toolNames.includes('x_post_tweet'));
  assert(toolNames.includes('x_search'));
  assert(toolNames.includes('x_get_profile'));
  assert(toolNames.includes('x_list_timeline'));
}

export async function testPostTweetToolHasCorrectSchema() {
  const tools = makeXTools();
  const postTweetTool = tools.find((t) => t.name === 'x_post_tweet');

  assert(postTweetTool);
  const schema = postTweetTool.inputSchema as Record<string, unknown>;
  assert.strictEqual(schema.type, 'object');
  assert((schema.required as string[]).includes('text'));
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.strictEqual((props.text as Record<string, unknown>).maxLength, 280);
}

export async function testSearchToolHasCorrectSchema() {
  const tools = makeXTools();
  const searchTool = tools.find((t) => t.name === 'x_search');

  assert(searchTool);
  const schema = searchTool.inputSchema as Record<string, unknown>;
  assert.strictEqual(schema.type, 'object');
  assert((schema.required as string[]).includes('query'));
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.strictEqual((props.limit as Record<string, unknown>).maximum, 100);
}

export async function testGetProfileToolHasCorrectSchema() {
  const tools = makeXTools();
  const getProfileTool = tools.find((t) => t.name === 'x_get_profile');

  assert(getProfileTool);
  const schema = getProfileTool.inputSchema as Record<string, unknown>;
  assert.strictEqual(schema.type, 'object');
}

export async function testListTimelineToolHasCorrectSchema() {
  const tools = makeXTools();
  const listTimelineTool = tools.find((t) => t.name === 'x_list_timeline');

  assert(listTimelineTool);
  const schema = listTimelineTool.inputSchema as Record<string, unknown>;
  assert.strictEqual(schema.type, 'object');
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.strictEqual((props.limit as Record<string, unknown>).maximum, 100);
}

export async function testPostTweetToolMissingSecret() {
  const tools = makeXTools();
  const postTweetTool = tools.find((t) => t.name === 'x_post_tweet');

  assert(postTweetTool);

  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError('Secret not found');
      },
    },
  } as unknown as ToolContext;

  const results: Array<Record<string, unknown>> = [];
  for await (const result of postTweetTool.executor.execute({ text: 'Hello' }, mockCtx)) {
    results.push(result);
  }

  assert.strictEqual(results.length, 1);
  assert.strictEqual((results[0] as Record<string, unknown>).type, 'error');
}

export async function testPostTweetToolEmptyText() {
  const tools = makeXTools();
  const postTweetTool = tools.find((t) => t.name === 'x_post_tweet');

  assert(postTweetTool);

  const mockCtx = {} as unknown as ToolContext;

  const results: Array<Record<string, unknown>> = [];
  for await (const result of postTweetTool.executor.execute({ text: '' }, mockCtx)) {
    results.push(result);
  }

  assert.strictEqual(results.length, 1);
  assert.strictEqual((results[0] as Record<string, unknown>).type, 'error');
}

export async function testSearchToolEmptyQuery() {
  const tools = makeXTools();
  const searchTool = tools.find((t) => t.name === 'x_search');

  assert(searchTool);

  const mockCtx = {} as unknown as ToolContext;

  const results: Array<Record<string, unknown>> = [];
  for await (const result of searchTool.executor.execute({ query: '' }, mockCtx)) {
    results.push(result);
  }

  assert.strictEqual(results.length, 1);
  assert.strictEqual((results[0] as Record<string, unknown>).type, 'error');
}
