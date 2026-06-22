// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretOpt, secretRequired } from './vault.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

const mockCtx = (vaultResolve: (name: string) => Promise<string | undefined>): ToolContext => ({
  vault: {
    resolve: vaultResolve,
    writeSecret: async () => {},
  },
} as any);

test('secretOpt returns value when secret exists', async () => {
  const ctx = mockCtx(async (name: string) => {
    if (name === '${TEST_SECRET}') return 'secret-value';
    throw new MissingSecretError(['KEY_NOT_FOUND']);
  });
  const result = await secretOpt(ctx, 'TEST_SECRET');
  assert.equal(result, 'secret-value');
});

test('secretOpt returns undefined on MissingSecretError', async () => {
  const ctx = mockCtx(async () => {
    throw new MissingSecretError(['KEY_NOT_FOUND']);
  });
  const result = await secretOpt(ctx, 'NONEXISTENT');
  assert.equal(result, undefined);
});

test('secretOpt propagates non-MissingSecretError exceptions', async () => {
  const ctx = mockCtx(async () => {
    throw new Error('Network error');
  });
  await assert.rejects(
    () => secretOpt(ctx, 'BROKEN'),
    (err: Error) => err.message === 'Network error'
  );
});

test('secretRequired returns value when secret exists', async () => {
  const ctx = mockCtx(async (name: string) => {
    if (name === '${REQUIRED_SECRET}') return 'required-value';
    throw new MissingSecretError(['KEY_NOT_FOUND']);
  });
  const result = await secretRequired(ctx, 'REQUIRED_SECRET');
  assert.equal(result, 'required-value');
});

test('secretRequired throws when secret is missing', async () => {
  const ctx = mockCtx(async () => {
    throw new MissingSecretError(['KEY_NOT_FOUND']);
  });
  await assert.rejects(
    () => secretRequired(ctx, 'MISSING'),
    (err: Error) => err.message === 'Missing secret: MISSING'
  );
});

test('secretRequired throws on other errors', async () => {
  const ctx = mockCtx(async () => {
    throw new Error('DB connection failed');
  });
  await assert.rejects(
    () => secretRequired(ctx, 'BROKEN'),
    (err: Error) => err.message === 'DB connection failed'
  );
});
