// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramClient } from './client.js';
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

test('InstagramClient.getAuthenticatedUser returns null without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  const result = await client.getAuthenticatedUser();
  assert.equal(result, null);
});

test('InstagramClient.getUserFeed returns empty array without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  const result = await client.getUserFeed(20);
  assert.deepEqual(result, []);
});

test('InstagramClient.searchHashtag returns null without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  const result = await client.searchHashtag('test');
  assert.equal(result, null);
});

test('InstagramClient.searchUsers returns empty array without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  const result = await client.searchUsers('test', 20);
  assert.deepEqual(result, []);
});

test('InstagramClient.postMedia returns null without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  const result = await client.postMedia('https://example.com/image.jpg', 'test caption');
  assert.equal(result, null);
});

test('InstagramClient.getHashtagMedia returns empty array without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  const result = await client.getHashtagMedia('hashtag-id', 20);
  assert.deepEqual(result, []);
});
