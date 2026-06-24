// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeMastodonTools } from './tools.js';

test('makeMastodonTools returns all four tools', () => {
  const names = makeMastodonTools(null).map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'mastodon_get_profile',
    'mastodon_list_timeline',
    'mastodon_post',
    'mastodon_search',
  ]);
});

test('every tool accepts an optional `account` selector', () => {
  for (const t of makeMastodonTools(null)) {
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('account' in props, `${t.name} should expose account`);
  }
});

test('mastodon_post schema requires text (max 500)', () => {
  const t = makeMastodonTools(null).find((x) => x.name === 'mastodon_post')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.ok(schema.required.includes('text'));
  assert.equal(schema.properties['text']?.['maxLength'], 500);
});

test('legacy fallback: errors clearly when nothing is connected', async () => {
  const t = makeMastodonTools(null).find((x) => x.name === 'mastodon_post')!;
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['MASTODON_ACCESS_TOKEN']);
      },
    },
  } as unknown as ToolContext;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: 'Hello' }, ctx)) out.push(r as Record<string, unknown>);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.['type'], 'error');
});

test('mastodon_post rejects empty text', async () => {
  const t = makeMastodonTools(null).find((x) => x.name === 'mastodon_post')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: '' }, {} as unknown as ToolContext)) {
    out.push(r as Record<string, unknown>);
  }
  assert.equal(out[0]?.['type'], 'error');
});

test('mastodon_search rejects empty query', async () => {
  const t = makeMastodonTools(null).find((x) => x.name === 'mastodon_search')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ query: '' }, {} as unknown as ToolContext)) {
    out.push(r as Record<string, unknown>);
  }
  assert.equal(out[0]?.['type'], 'error');
});
