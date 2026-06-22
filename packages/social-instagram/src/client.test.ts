// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramClient, InstagramAuthError, InstagramPostError } from './client.js';
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

test('InstagramClient.getAuthenticatedUser throws InstagramAuthError without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  await assert.rejects(
    () => client.getAuthenticatedUser(),
    InstagramAuthError
  );
});

test('InstagramClient.getUserFeed throws InstagramAuthError without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  await assert.rejects(
    () => client.getUserFeed(20),
    InstagramAuthError
  );
});

test('InstagramClient.searchHashtag throws InstagramAuthError without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  await assert.rejects(
    () => client.searchHashtag('test'),
    InstagramAuthError
  );
});

test('InstagramClient.postMedia throws InstagramPostError without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  await assert.rejects(
    () => client.postMedia('https://example.com/image.jpg', 'test caption'),
    InstagramAuthError
  );
});

test('InstagramClient.getHashtagMedia throws InstagramAuthError without token', async () => {
  const ctx = mockCtx();
  const client = new InstagramClient(ctx);
  await assert.rejects(
    () => client.getHashtagMedia('hashtag-id', 20),
    InstagramAuthError
  );
});
