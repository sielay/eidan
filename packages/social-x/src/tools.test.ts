// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { makeXTools } from './tools.js';

test('makeXTools returns all four tools', () => {
  const names = makeXTools(null).map((t) => t.name);
  assert.deepEqual(names.sort(), ['x_get_profile', 'x_list_timeline', 'x_post_tweet', 'x_search']);
});

test('every tool accepts an optional `account` selector', () => {
  for (const t of makeXTools(null)) {
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('account' in props, `${t.name} should expose account`);
  }
});

test('x_post_tweet schema requires text (max 280)', () => {
  const t = makeXTools(null).find((x) => x.name === 'x_post_tweet')!;
  const schema = t.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.ok(schema.required.includes('text'));
  assert.equal(schema.properties['text']?.['maxLength'], 280);
});

test('legacy fallback: errors clearly when nothing is connected', async () => {
  const t = makeXTools(null).find((x) => x.name === 'x_post_tweet')!;
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['X_ACCESS_TOKEN']);
      },
    },
  } as unknown as ToolContext;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: 'Hello' }, ctx)) out.push(r as Record<string, unknown>);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.['type'], 'error');
});

test('x_post_tweet rejects empty text', async () => {
  const t = makeXTools(null).find((x) => x.name === 'x_post_tweet')!;
  const out: Array<Record<string, unknown>> = [];
  for await (const r of t.executor.execute({ text: '' }, {} as unknown as ToolContext)) out.push(r as Record<string, unknown>);
  assert.equal(out[0]?.['type'], 'error');
});
