// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeThreadsTools } from './tools.js';

test('makeThreadsTools returns all four tools', () => {
  const names = makeThreadsTools(null).map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'threads_get_profile',
    'threads_list_timeline',
    'threads_post_thread',
    'threads_search',
  ]);
});

test('every tool accepts an optional `account` selector', () => {
  for (const t of makeThreadsTools(null)) {
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('account' in props, `${t.name} should expose account`);
  }
});

test('threads_post_thread schema requires text (max 500)', () => {
  const t = makeThreadsTools(null).find((x) => x.name === 'threads_post_thread')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.ok(schema.required.includes('text'));
  assert.equal(schema.properties['text']?.['maxLength'], 500);
  assert.ok(schema.properties['reply_to']);
});

test('threads_search schema requires query', () => {
  const t = makeThreadsTools(null).find((x) => x.name === 'threads_search')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, unknown> };
  assert.ok(schema.required.includes('query'));
  assert.ok(schema.properties['limit']);
});

test('legacy fallback: errors clearly when nothing is connected', async () => {
  const t = makeThreadsTools(null).find((x) => x.name === 'threads_post_thread')!;
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['THREADS_ACCESS_TOKEN']);
      },
    },
  } as unknown as ToolContext;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: 'Hello' }, ctx)) out.push(r as Record<string, unknown>);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.['type'], 'error');
});

test('threads_post_thread rejects empty text', async () => {
  const t = makeThreadsTools(null).find((x) => x.name === 'threads_post_thread')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: '' }, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});

test('threads_search rejects empty query', async () => {
  const t = makeThreadsTools(null).find((x) => x.name === 'threads_search')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ query: '' }, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});
