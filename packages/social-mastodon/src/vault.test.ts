// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretOpt, secretRequired } from './vault.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

const mockCtx = (secrets: Record<string, string | undefined> = {}): ToolContext =>
  ({
    vault: {
      resolve: async (name: string) => {
        const key = name.replace(/^\$\{/, '').replace(/\}$/, '');
        const value = secrets[key];
        if (value === undefined) {
          throw new MissingSecretError([key]);
        }
        return value;
      },
    },
  }) as unknown as ToolContext;

test('secretOpt - returns secret when present', async () => {
  const ctx = mockCtx({ TEST_SECRET: 'test-value' });
  const result = await secretOpt(ctx, 'TEST_SECRET');
  assert.equal(result, 'test-value');
});

test('secretOpt - returns undefined when missing', async () => {
  const ctx = mockCtx({});
  const result = await secretOpt(ctx, 'MISSING_SECRET');
  assert.equal(result, undefined);
});

test('secretRequired - returns secret when present', async () => {
  const ctx = mockCtx({ REQUIRED_SECRET: 'secret-value' });
  const result = await secretRequired(ctx, 'REQUIRED_SECRET');
  assert.equal(result, 'secret-value');
});

test('secretRequired - throws when missing', async () => {
  const ctx = mockCtx({});
  await assert.rejects(async () => {
    await secretRequired(ctx, 'MISSING_REQUIRED');
  }, /Missing secret/);
});
