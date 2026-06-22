// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { secretOpt, secretRequired } from './vault.js';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

test('secretOpt returns undefined for missing secret', async () => {
  const mockContext: Partial<ToolContext> = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError('TEST_SECRET');
      },
      writeSecret: async () => {},
      readSecret: async () => undefined,
    },
  };

  const result = await secretOpt(mockContext as ToolContext, 'TEST_SECRET');
  assert.equal(result, undefined);
});

test('secretOpt returns value for existing secret', async () => {
  const mockContext: Partial<ToolContext> = {
    vault: {
      resolve: async () => 'secret-value',
      writeSecret: async () => {},
      readSecret: async () => undefined,
    },
  };

  const result = await secretOpt(mockContext as ToolContext, 'TEST_SECRET');
  assert.equal(result, 'secret-value');
});

test('secretRequired returns value for existing secret', async () => {
  const mockContext: Partial<ToolContext> = {
    vault: {
      resolve: async () => 'secret-value',
      writeSecret: async () => {},
      readSecret: async () => undefined,
    },
  };

  const result = await secretRequired(mockContext as ToolContext, 'TEST_SECRET');
  assert.equal(result, 'secret-value');
});

test('secretRequired throws for missing secret', async () => {
  const mockContext: Partial<ToolContext> = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError('TEST_SECRET');
      },
      writeSecret: async () => {},
      readSecret: async () => undefined,
    },
  };

  try {
    await secretRequired(mockContext as ToolContext, 'TEST_SECRET');
    assert.fail('Should have thrown');
  } catch (exc) {
    assert(exc instanceof Error);
    assert(exc.message.includes('Missing secret'));
  }
});

test('secretOpt re-throws non-MissingSecretError', async () => {
  const testError = new Error('Network error');
  const mockContext: Partial<ToolContext> = {
    vault: {
      resolve: async () => {
        throw testError;
      },
      writeSecret: async () => {},
      readSecret: async () => undefined,
    },
  };

  try {
    await secretOpt(mockContext as ToolContext, 'TEST_SECRET');
    assert.fail('Should have thrown');
  } catch (exc) {
    assert.equal(exc, testError);
  }
});
