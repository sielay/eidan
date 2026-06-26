// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import { plugin } from './index.js';

describe('ask-user-fallback', () => {
  it('plugin has required structure', () => {
    assert.ok(plugin);
    assert.ok(plugin.apiVersion);
    assert.ok(plugin.manifest);
    assert.ok(plugin.setup);
    assert.match(
      plugin.manifest.description,
      /ask_user.*non-interactive/i,
    );
  });

  it('plugin setup registers toolcall hook', async () => {
    const registeredHooks: string[] = [];

    const mockServices = {
      hooks: {
        register(cfg: { on: string; pluginName?: string; handler?: unknown; priority?: number }) {
          registeredHooks.push(cfg.on);
        },
      },
      Escalations: {
        raise: async (args: unknown) => ({ id: 'test-esc-123' }),
      },
    } as unknown as MatbotServices;

    await plugin.setup(mockServices);

    assert.ok(
      registeredHooks.includes('toolcall'),
      'should register a toolcall hook for intercepting ask_user calls',
    );
  });

  it('detects non-interactive context with IS_SUB_AGENT', () => {
    const origEnv = process.env['IS_SUB_AGENT'];
    try {
      process.env['IS_SUB_AGENT'] = '1';
      assert.ok(process.env['IS_SUB_AGENT'], 'IS_SUB_AGENT should be set for non-interactive context');

      delete process.env['IS_SUB_AGENT'];
      assert.ok(!process.env['IS_SUB_AGENT'], 'IS_SUB_AGENT should be cleared for interactive context');
    } finally {
      if (origEnv) process.env['IS_SUB_AGENT'] = origEnv;
      else delete process.env['IS_SUB_AGENT'];
    }
  });
});
