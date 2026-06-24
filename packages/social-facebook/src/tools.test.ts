// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeFacebookTools } from './tools.js';

test('makeFacebookTools returns all four tools', () => {
  const names = makeFacebookTools(null).map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'facebook_get_profile',
    'facebook_list_feed',
    'facebook_post_feed',
    'facebook_search',
  ]);
});

test('every tool accepts an optional `account` selector', () => {
  for (const t of makeFacebookTools(null)) {
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('account' in props, `${t.name} should expose account`);
  }
});

test('facebook_post_feed schema requires text', () => {
  const t = makeFacebookTools(null).find((x) => x.name === 'facebook_post_feed')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.ok(schema.required.includes('text'));
  assert.ok(schema.properties['image_url']);
});

test('facebook_search schema requires query', () => {
  const t = makeFacebookTools(null).find((x) => x.name === 'facebook_search')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.ok(schema.required.includes('query'));
  assert.ok(schema.properties['limit']);
});

test('legacy fallback: errors clearly when nothing is connected', async () => {
  const t = makeFacebookTools(null).find((x) => x.name === 'facebook_post_feed')!;
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['FACEBOOK_ACCESS_TOKEN']);
      },
    },
  } as unknown as ToolContext;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: 'Hello' }, ctx)) out.push(r as Record<string, unknown>);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.['type'], 'error');
  assert.ok(String(out[0]?.['message']).includes("Facebook isn't connected"));
});

test('facebook_post_feed rejects empty text', async () => {
  const t = makeFacebookTools(null).find((x) => x.name === 'facebook_post_feed')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: '' }, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});

test('facebook_search rejects empty query', async () => {
  const t = makeFacebookTools(null).find((x) => x.name === 'facebook_search')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ query: '' }, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});
