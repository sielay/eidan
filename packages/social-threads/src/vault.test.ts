// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretOpt, secretRequired } from './vault.js';
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

test('secretOpt returns value when secret exists', async () => {
  const ctx = mockCtx({ MY_SECRET: 'secret-value' });
  const value = await secretOpt(ctx, 'MY_SECRET');
  assert.equal(value, 'secret-value');
});

test('secretOpt returns undefined when secret is missing', async () => {
  const ctx = mockCtx({});
  const value = await secretOpt(ctx, 'MISSING_SECRET');
  assert.equal(value, undefined);
});

test('secretRequired returns value when secret exists', async () => {
  const ctx = mockCtx({ MY_SECRET: 'secret-value' });
  const value = await secretRequired(ctx, 'MY_SECRET');
  assert.equal(value, 'secret-value');
});

test('secretRequired throws when secret is missing', async () => {
  const ctx = mockCtx({});
  try {
    await secretRequired(ctx, 'MISSING_SECRET');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok((err as any).message.includes('Missing secret'));
  }
});

test('secretOpt handles empty string as falsy', async () => {
  const ctx = mockCtx({ EMPTY_SECRET: '' });
  const value = await secretOpt(ctx, 'EMPTY_SECRET');
  assert.equal(value, '');
});
