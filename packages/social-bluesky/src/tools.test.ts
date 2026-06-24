// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeBlueskyTools } from './tools.js';

test('makeBlueskyTools returns all three tools', () => {
  const names = makeBlueskyTools(null).map((t) => t.name);
  assert.deepEqual(names.sort(), ['bluesky_post', 'bluesky_read_feed', 'bluesky_search']);
});

test('every tool accepts an optional `account` selector', () => {
  for (const t of makeBlueskyTools(null)) {
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('account' in props, `${t.name} should expose account`);
  }
});

test('bluesky_post schema requires text (max 300)', () => {
  const t = makeBlueskyTools(null).find((x) => x.name === 'bluesky_post')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.ok(schema.required.includes('text'));
  assert.equal(schema.properties['text']?.['maxLength'], 300);
});

test('legacy fallback: errors clearly when nothing is connected', async () => {
  const t = makeBlueskyTools(null).find((x) => x.name === 'bluesky_post')!;
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['BLUESKY_HANDLE']);
      },
    },
  } as unknown as ToolContext;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: 'Hello' }, ctx)) out.push(r as Record<string, unknown>);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.['type'], 'error');
});

test('bluesky_post rejects empty text', async () => {
  const t = makeBlueskyTools(null).find((x) => x.name === 'bluesky_post')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: '' }, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});

test('bluesky_search rejects empty query', async () => {
  const t = makeBlueskyTools(null).find((x) => x.name === 'bluesky_search')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ query: '' }, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});
