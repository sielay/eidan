// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'assert';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';
import { secretOpt, secretRequired } from './vault.js';

export async function testSecretOpt() {
  const mockCtx = {
    vault: {
      resolve: async (template: string) => {
        if (template === '${TEST_SECRET}') {
          return 'test-value';
        }
        throw new MissingSecretError(`Secret not found: ${template}`);
      },
    },
  } as unknown as ToolContext;

  const value = await secretOpt(mockCtx, 'TEST_SECRET');
  assert.strictEqual(value, 'test-value');
}

export async function testSecretOptMissing() {
  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError('Secret not found');
      },
    },
  } as unknown as ToolContext;

  const value = await secretOpt(mockCtx, 'MISSING_SECRET');
  assert.strictEqual(value, undefined);
}

export async function testSecretRequired() {
  const mockCtx = {
    vault: {
      resolve: async (template: string) => {
        if (template === '${REQUIRED_SECRET}') {
          return 'required-value';
        }
        throw new MissingSecretError('Secret not found');
      },
    },
  } as unknown as ToolContext;

  const value = await secretRequired(mockCtx, 'REQUIRED_SECRET');
  assert.strictEqual(value, 'required-value');
}

export async function testSecretRequiredMissing() {
  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError('Secret not found');
      },
    },
  } as unknown as ToolContext;

  try {
    await secretRequired(mockCtx, 'MISSING_SECRET');
    assert.fail('Should have thrown');
  } catch (e) {
    assert(e instanceof Error);
    assert(e.message.includes('Missing secret'));
  }
}
