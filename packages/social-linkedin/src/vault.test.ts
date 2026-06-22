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
  const ctx = mockCtx({ TEST_SECRET: 'secret-value' });
  const result = await secretOpt(ctx, 'TEST_SECRET');
  assert.equal(result, 'secret-value');
});

test('secretOpt returns undefined when secret is missing', async () => {
  const ctx = mockCtx({});
  const result = await secretOpt(ctx, 'MISSING_SECRET');
  assert.equal(result, undefined);
});

test('secretRequired returns value when secret exists', async () => {
  const ctx = mockCtx({ TEST_SECRET: 'secret-value' });
  const result = await secretRequired(ctx, 'TEST_SECRET');
  assert.equal(result, 'secret-value');
});

test('secretRequired throws when secret is missing', async () => {
  const ctx = mockCtx({});
  await assert.rejects(async () => {
    await secretRequired(ctx, 'MISSING_SECRET');
  });
});
