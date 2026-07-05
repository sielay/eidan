// SPDX-License-Identifier: AGPL-3.0-or-later
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { plugin } from './index.js';
import type { MatbotServices } from '@matatbread/matbot-plugin-api';

test('plugin exports', () => {
  assert(plugin);
  assert(plugin.apiVersion);
  assert(plugin.manifest);
  assert(plugin.setup);
});

test('plugin setup with disabled flag', async () => {
  const original = process.env['EIDAN_TOOL_FAILURE_DETECTION'];
  try {
    delete process.env['EIDAN_TOOL_FAILURE_DETECTION'];
    const mockServices = { hooks: { register: () => {} } } as unknown as MatbotServices;
    await plugin.setup?.(mockServices);
    // Should not register hooks when disabled
  } finally {
    if (original) process.env['EIDAN_TOOL_FAILURE_DETECTION'] = original;
  }
});

test('plugin registers toolresult hook when enabled', async () => {
  const original = process.env['EIDAN_TOOL_FAILURE_DETECTION'];
  try {
    process.env['EIDAN_TOOL_FAILURE_DETECTION'] = '1';
    let registered = false;
    const mockServices = {
      hooks: {
        register: (cfg: unknown) => {
          const c = cfg as { on?: string };
          if (c.on === 'toolresult') registered = true;
        },
      },
      singleTurn: async () => ({ text: '{"strategy":"CONTINUE_WITH_ERROR","reasoning":"test"}' }),
    } as unknown as MatbotServices;
    await plugin.setup?.(mockServices);
    assert(registered, 'toolresult hook should be registered');
  } finally {
    if (original) {
      process.env['EIDAN_TOOL_FAILURE_DETECTION'] = original;
    } else {
      delete process.env['EIDAN_TOOL_FAILURE_DETECTION'];
    }
  }
});

test('hook handler passes through non-error results', async () => {
  const original = process.env['EIDAN_TOOL_FAILURE_DETECTION'];
  try {
    process.env['EIDAN_TOOL_FAILURE_DETECTION'] = '1';
    let handler: ((ctx: unknown) => Promise<unknown>) | undefined;
    const mockServices = {
      hooks: {
        register: (cfg: unknown) => {
          const c = cfg as { handler?: (ctx: unknown) => Promise<unknown> };
          handler = c.handler;
        },
      },
    } as unknown as MatbotServices;
    await plugin.setup?.(mockServices);
    assert(handler);

    const ctx = { isError: false, result: 'success' };
    const result = await handler(ctx);
    assert.strictEqual(result, undefined, 'non-errors should pass through');
  } finally {
    if (original) {
      process.env['EIDAN_TOOL_FAILURE_DETECTION'] = original;
    } else {
      delete process.env['EIDAN_TOOL_FAILURE_DETECTION'];
    }
  }
});

test('hook handler returns modified result on error', async () => {
  const original = process.env['EIDAN_TOOL_FAILURE_DETECTION'];
  try {
    process.env['EIDAN_TOOL_FAILURE_DETECTION'] = '1';
    let handler: ((ctx: unknown) => Promise<unknown>) | undefined;
    const mockServices = {
      hooks: {
        register: (cfg: unknown) => {
          const c = cfg as { handler?: (ctx: unknown) => Promise<unknown> };
          handler = c.handler;
        },
      },
      singleTurn: async () => ({
        text: '{"strategy":"CONTINUE_WITH_ERROR","reasoning":"test error"}',
      }),
    } as unknown as MatbotServices;
    await plugin.setup?.(mockServices);
    assert(handler);

    const ctx = {
      isError: true,
      result: 'tool failed',
      tool: { name: 'test_tool', input: { test: true } },
    };
    const result = await handler(ctx);
    assert(result, 'handler should return a result');
    const res = result as { result?: string };
    assert(res.result?.includes('Recovery Strategy'), 'result should include recovery guidance');
  } finally {
    if (original) {
      process.env['EIDAN_TOOL_FAILURE_DETECTION'] = original;
    } else {
      delete process.env['EIDAN_TOOL_FAILURE_DETECTION'];
    }
  }
});

test('hook handler returns critical failure stop on STOP_AND_ESCALATE', async () => {
  const original = process.env['EIDAN_TOOL_FAILURE_DETECTION'];
  try {
    process.env['EIDAN_TOOL_FAILURE_DETECTION'] = '1';
    let handler: ((ctx: unknown) => Promise<unknown>) | undefined;
    const mockServices = {
      hooks: {
        register: (cfg: unknown) => {
          const c = cfg as { handler?: (ctx: unknown) => Promise<unknown> };
          handler = c.handler;
        },
      },
      singleTurn: async () => ({
        text: '{"strategy":"STOP_AND_ESCALATE","reasoning":"auth failure"}',
      }),
    } as unknown as MatbotServices;
    await plugin.setup?.(mockServices);
    assert(handler);

    const ctx = {
      isError: true,
      result: 'authentication failed',
      tool: { name: 'auth_tool', input: { token: 'bad' } },
    };
    const result = await handler(ctx);
    assert(result, 'handler should return a result');
    const res = result as { result?: string };
    assert(res.result?.includes('Critical tool failure'), 'result should indicate critical failure');
    assert(res.result?.includes('being stopped'), 'result should mention escalation');
  } finally {
    if (original) {
      process.env['EIDAN_TOOL_FAILURE_DETECTION'] = original;
    } else {
      delete process.env['EIDAN_TOOL_FAILURE_DETECTION'];
    }
  }
});
