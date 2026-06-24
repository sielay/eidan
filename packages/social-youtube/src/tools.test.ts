// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeYoutubeTools } from './tools.js';

test('makeYoutubeTools returns all four tools', () => {
  const names = makeYoutubeTools(null).map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'youtube_get_channel',
    'youtube_list_videos',
    'youtube_post_comment',
    'youtube_search',
  ]);
});

test('every tool accepts an optional `account` selector', () => {
  for (const t of makeYoutubeTools(null)) {
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('account' in props, `${t.name} should expose account`);
  }
});

test('youtube_post_comment schema requires video_id and text (max 10000)', () => {
  const t = makeYoutubeTools(null).find((x) => x.name === 'youtube_post_comment')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(schema.required, ['video_id', 'text']);
  assert.equal(schema.properties['text']?.['maxLength'], 10000);
});

test('youtube_search schema requires query', () => {
  const t = makeYoutubeTools(null).find((x) => x.name === 'youtube_search')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, unknown> };
  assert.ok(schema.required.includes('query'));
  assert.ok('limit' in schema.properties);
});

test('legacy fallback: errors clearly when nothing is connected', async () => {
  const t = makeYoutubeTools(null).find((x) => x.name === 'youtube_post_comment')!;
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['YOUTUBE_ACCESS_TOKEN']);
      },
    },
  } as unknown as ToolContext;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ video_id: 'vid123', text: 'hello' }, ctx)) {
    out.push(r as Record<string, unknown>);
  }
  assert.equal(out.length, 1);
  assert.equal(out[0]?.['type'], 'error');
  assert.match(String(out[0]?.['message']), /YouTube isn't connected/);
});

test('youtube_post_comment rejects missing inputs', async () => {
  const t = makeYoutubeTools(null).find((x) => x.name === 'youtube_post_comment')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({}, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
  assert.match(String(out[0]?.['message']), /required/i);
});

test('youtube_search rejects empty query', async () => {
  const t = makeYoutubeTools(null).find((x) => x.name === 'youtube_search')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({}, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
  assert.match(String(out[0]?.['message']), /query is required/);
});
