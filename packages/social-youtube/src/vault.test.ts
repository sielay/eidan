// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import * as assert from 'node:assert';
import { secretOpt, secretRequired } from './vault.js';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

test('secretOpt: returns value when secret exists', async () => {
  const mockCtx = {
    vault: {
      resolve: async () => 'test-token',
    },
  } as any;

  const result = await secretOpt(mockCtx, 'TEST_SECRET');
  assert.strictEqual(result, 'test-token');
});

test('secretOpt: returns undefined when secret is missing', async () => {
  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['TEST_SECRET']);
      },
    },
  } as any;

  const result = await secretOpt(mockCtx, 'TEST_SECRET');
  assert.strictEqual(result, undefined);
});

test('secretRequired: returns value when secret exists', async () => {
  const mockCtx = {
    vault: {
      resolve: async () => 'test-token',
    },
  } as any;

  const result = await secretRequired(mockCtx, 'TEST_SECRET');
  assert.strictEqual(result, 'test-token');
});

test('secretRequired: throws when secret is missing', async () => {
  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['TEST_SECRET']);
      },
    },
  } as any;

  await assert.rejects(
    async () => secretRequired(mockCtx, 'TEST_SECRET'),
    /Missing secret: TEST_SECRET/
  );
});
