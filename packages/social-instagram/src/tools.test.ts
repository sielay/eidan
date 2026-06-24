// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeInstagramTools } from './tools.js';

test('makeInstagramTools returns all four tools', () => {
  const names = makeInstagramTools(null).map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'instagram_get_profile',
    'instagram_list_feed',
    'instagram_post_feed',
    'instagram_search',
  ]);
});

test('every tool accepts an optional `account` selector', () => {
  for (const t of makeInstagramTools(null)) {
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('account' in props, `${t.name} should expose account`);
  }
});

test('instagram_post_feed schema requires text (max 2200) and image_url', () => {
  const t = makeInstagramTools(null).find((x) => x.name === 'instagram_post_feed')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.ok(schema.required.includes('text'));
  assert.ok(schema.required.includes('image_url'));
  assert.equal(schema.properties['text']?.['maxLength'], 2200);
});

test('instagram_search schema requires query', () => {
  const t = makeInstagramTools(null).find((x) => x.name === 'instagram_search')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, unknown> };
  assert.ok(schema.required.includes('query'));
  assert.ok('limit' in schema.properties);
});

test('legacy fallback: errors clearly when nothing is connected', async () => {
  const t = makeInstagramTools(null).find((x) => x.name === 'instagram_post_feed')!;
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['INSTAGRAM_ACCESS_TOKEN']);
      },
    },
  } as unknown as ToolContext;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: 'Hello', image_url: 'https://example.com/i.jpg' }, ctx))
    out.push(r as Record<string, unknown>);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.['type'], 'error');
});

test('instagram_post_feed rejects empty text', async () => {
  const t = makeInstagramTools(null).find((x) => x.name === 'instagram_post_feed')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: '' }, {} as unknown as ToolContext))
    out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});

test('instagram_post_feed rejects missing image_url', async () => {
  const t = makeInstagramTools(null).find((x) => x.name === 'instagram_post_feed')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: 'Hello' }, {} as unknown as ToolContext))
    out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
  assert.ok(String(out[0]?.['message']).includes('image_url is required'));
});

test('instagram_search rejects empty query', async () => {
  const t = makeInstagramTools(null).find((x) => x.name === 'instagram_search')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({}, {} as unknown as ToolContext))
    out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});
