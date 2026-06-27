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

  it('plugin setup registers toolresult hook', async () => {
    const registeredHooks: Array<{ on: string; priority?: number }> = [];

    const mockServices = {
      hooks: {
        register(cfg: { on: string; pluginName?: string; handler?: unknown; priority?: number }) {
          registeredHooks.push({ on: cfg.on, priority: cfg.priority });
        },
      },
      Escalations: {
        raise: async (args: unknown) => ({ id: 'test-esc-123' }),
      },
    } as unknown as MatbotServices;

    await plugin.setup(mockServices);

    const toolresultHook = registeredHooks.find(h => h.on === 'toolresult');
    assert.ok(toolresultHook, 'should register a toolresult hook');
    assert.equal(toolresultHook?.priority, 60, 'toolresult hook should have priority 60');
  });

  describe('toolresult hook behavior', () => {
    it('escalates ask_user confirm errors in non-interactive context', async () => {
      let escalationCalled = false;
      const mockServices = {
        hooks: { register() {} },
        Escalations: {
          raise: async (args: Record<string, unknown>) => {
            escalationCalled = true;
            assert.equal(args.reasonClass, 'missing_input');
            assert.equal(args.severity, 'medium');
            return { id: 'esc-123' };
          },
        },
        AskUserFallbackConfig: {
          isNonInteractive: true,
        },
      } as unknown as MatbotServices;

      let hookHandler: unknown;
      (mockServices as { hooks: { register: (cfg: unknown) => void } }).hooks.register = (cfg: any) => {
        if (cfg.on === 'toolresult') hookHandler = cfg.handler;
      };

      await plugin.setup(mockServices);

      const result = await (hookHandler as any)({
        tool: { name: 'ask_user', input: { type: 'confirm', label: 'Test?' } },
        isError: true,
        session: { id: 'session-123' },
      });

      assert.ok(escalationCalled, 'should have called escalations.raise');
      assert.deepEqual(result, {
        result: {
          decision: 'PENDING_HUMAN_REVIEW',
          escalation_id: 'esc-123',
          message: 'Test?: decision escalated to inbox (non-interactive context)',
        },
      });
    });

    it('does not escalate if ask_user succeeded', async () => {
      let escalationCalled = false;
      const mockServices = {
        hooks: { register() {} },
        Escalations: {
          raise: async () => {
            escalationCalled = true;
            return { id: 'esc-123' };
          },
        },
        AskUserFallbackConfig: {
          isNonInteractive: true,
        },
      } as unknown as MatbotServices;

      let hookHandler: unknown;
      (mockServices as { hooks: { register: (cfg: unknown) => void } }).hooks.register = (cfg: any) => {
        if (cfg.on === 'toolresult') hookHandler = cfg.handler;
      };

      await plugin.setup(mockServices);

      const result = await (hookHandler as any)({
        tool: { name: 'ask_user', input: { type: 'confirm', label: 'Test?' } },
        isError: false,
        session: { id: 'session-123' },
      });

      assert.ok(!escalationCalled, 'should not escalate if tool succeeded');
      assert.equal(result, undefined, 'should return undefined for non-error results');
    });

    it('does not escalate for non-confirm types', async () => {
      let escalationCalled = false;
      const mockServices = {
        hooks: { register() {} },
        Escalations: {
          raise: async () => {
            escalationCalled = true;
            return { id: 'esc-123' };
          },
        },
        AskUserFallbackConfig: {
          isNonInteractive: true,
        },
      } as unknown as MatbotServices;

      let hookHandler: unknown;
      (mockServices as { hooks: { register: (cfg: unknown) => void } }).hooks.register = (cfg: any) => {
        if (cfg.on === 'toolresult') hookHandler = cfg.handler;
      };

      await plugin.setup(mockServices);

      const result = await (hookHandler as any)({
        tool: { name: 'ask_user', input: { type: 'text', label: 'What?' } },
        isError: true,
        session: { id: 'session-123' },
      });

      assert.ok(!escalationCalled, 'should not escalate for non-confirm types');
      assert.equal(result, undefined);
    });

    it('does not escalate in interactive context', async () => {
      let escalationCalled = false;
      const mockServices = {
        hooks: { register() {} },
        Escalations: {
          raise: async () => {
            escalationCalled = true;
            return { id: 'esc-123' };
          },
        },
        AskUserFallbackConfig: {
          isNonInteractive: false,
        },
      } as unknown as MatbotServices;

      let hookHandler: unknown;
      (mockServices as { hooks: { register: (cfg: unknown) => void } }).hooks.register = (cfg: any) => {
        if (cfg.on === 'toolresult') hookHandler = cfg.handler;
      };

      await plugin.setup(mockServices);

      const result = await (hookHandler as any)({
        tool: { name: 'ask_user', input: { type: 'confirm', label: 'Test?' } },
        isError: true,
        session: { id: 'session-123' },
      });

      assert.ok(!escalationCalled, 'should not escalate in interactive context');
      assert.equal(result, undefined);
    });
  });
});
