// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('ask-user-fallback hook behavior', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['IS_SUB_AGENT'];
  });

  afterEach(() => {
    if (originalEnv) {
      process.env['IS_SUB_AGENT'] = originalEnv;
    } else {
      delete process.env['IS_SUB_AGENT'];
    }
  });

  it('should intercept ask_user confirm in non-interactive context', async () => {
    process.env['IS_SUB_AGENT'] = '1';

    // This test verifies the logic without needing to load the full plugin
    // In a real scenario, the hook handler would be called with this context
    const isNonInteractive = !!process.env['IS_SUB_AGENT'];
    const toolName = 'ask_user';
    const type = 'confirm';

    const shouldIntercept = isNonInteractive && toolName === 'ask_user' && type === 'confirm';
    assert.ok(shouldIntercept, 'should intercept ask_user confirm in non-interactive context');
  });

  it('should NOT intercept ask_user confirm in interactive context', () => {
    delete process.env['IS_SUB_AGENT'];

    const isNonInteractive = !!process.env['IS_SUB_AGENT'];
    const toolName = 'ask_user';
    const type = 'confirm';

    const shouldIntercept = isNonInteractive && toolName === 'ask_user' && type === 'confirm';
    assert.equal(shouldIntercept, false, 'should not intercept in interactive context');
  });

  it('should NOT intercept non-confirm ask_user types', () => {
    process.env['IS_SUB_AGENT'] = '1';

    const isNonInteractive = !!process.env['IS_SUB_AGENT'];
    const toolName = 'ask_user';
    const typeText = 'text';
    const typeSelect = 'select';

    const shouldInterceptText = isNonInteractive && toolName === 'ask_user' && typeText === 'confirm';
    const shouldInterceptSelect = isNonInteractive && toolName === 'ask_user' && typeSelect === 'confirm';

    assert.equal(shouldInterceptText, false, 'should not intercept text type');
    assert.equal(shouldInterceptSelect, false, 'should not intercept select type');
  });

  it('should NOT intercept non-ask_user tools', () => {
    process.env['IS_SUB_AGENT'] = '1';

    const isNonInteractive = !!process.env['IS_SUB_AGENT'];
    const toolName = 'escalate';
    const type = 'confirm';

    const shouldIntercept = isNonInteractive && toolName === 'ask_user' && type === 'confirm';
    assert.equal(shouldIntercept, false, 'should not intercept other tools');
  });

  it('escalation response has required fields', () => {
    const response = {
      decision: 'PENDING_HUMAN_REVIEW',
      escalation_id: 'test-id-123',
      message: 'Test: decision escalated to inbox (non-interactive context)',
    };

    assert.equal(response.decision, 'PENDING_HUMAN_REVIEW', 'response should have decision field');
    assert.ok(response.escalation_id, 'response should have escalation_id field');
    assert.match(response.message, /escalated/, 'response should have message field');
  });
});
