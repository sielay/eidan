// SPDX-License-Identifier: AGPL-3.0-or-later
import { strict as assert } from 'assert';
import { test } from 'node:test';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { secretOpt, secretRequired } from './vault.js';

test('secretOpt resolves existing secret', async () => {
  const ctx = {
    vault: {
      resolve: async (key: string) => {
        if (key === '${TEST_SECRET}') return 'secret-value';
        throw new MissingSecretError(['TEST_SECRET']);
      },
    },
  } as unknown as ToolContext;

  const result = await secretOpt(ctx, 'TEST_SECRET');
  assert.equal(result, 'secret-value');
});

test('secretOpt returns undefined for missing secret', async () => {
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['MISSING_SECRET']);
      },
    },
  } as unknown as ToolContext;

  const result = await secretOpt(ctx, 'MISSING_SECRET');
  assert.equal(result, undefined);
});

test('secretRequired returns value for existing secret', async () => {
  const ctx = {
    vault: {
      resolve: async (key: string) => {
        if (key === '${TEST_SECRET}') return 'secret-value';
        throw new MissingSecretError(['TEST_SECRET']);
      },
    },
  } as unknown as ToolContext;

  const result = await secretRequired(ctx, 'TEST_SECRET');
  assert.equal(result, 'secret-value');
});

test('secretRequired throws for missing secret', async () => {
  const ctx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError(['MISSING_SECRET']);
      },
    },
  } as unknown as ToolContext;

  try {
    await secretRequired(ctx, 'MISSING_SECRET');
    assert.fail('should have thrown');
  } catch (exc) {
    assert(exc instanceof Error);
    assert(exc.message.includes('Missing secret: MISSING_SECRET'));
  }
});
