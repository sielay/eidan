// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeAgentName, buildAgentTitle } from './agent-title.js';

describe('sanitizeAgentName', () => {
  it('returns "agent" for null/undefined', () => {
    assert.strictEqual(sanitizeAgentName(null), 'agent');
    assert.strictEqual(sanitizeAgentName(undefined), 'agent');
  });

  it('returns "agent" for empty string', () => {
    assert.strictEqual(sanitizeAgentName(''), 'agent');
  });

  it('lowercases input', () => {
    assert.strictEqual(sanitizeAgentName('MyAgent'), 'myagent');
    assert.strictEqual(sanitizeAgentName('UPPERCASE'), 'uppercase');
  });

  it('replaces sequences of non-alphanumeric chars with single hyphen', () => {
    assert.strictEqual(sanitizeAgentName('hello-world'), 'hello-world');
    assert.strictEqual(sanitizeAgentName('hello--world'), 'hello-world');
    assert.strictEqual(sanitizeAgentName('hello___world'), 'hello-world');
    assert.strictEqual(sanitizeAgentName('hello world'), 'hello-world');
    assert.strictEqual(sanitizeAgentName('hello@@@world'), 'hello-world');
  });

  it('removes leading hyphens', () => {
    assert.strictEqual(sanitizeAgentName('-hello'), 'hello');
    assert.strictEqual(sanitizeAgentName('---hello'), 'hello');
  });

  it('removes trailing hyphens', () => {
    assert.strictEqual(sanitizeAgentName('hello-'), 'hello');
    assert.strictEqual(sanitizeAgentName('hello---'), 'hello');
  });

  it('removes both leading and trailing hyphens', () => {
    assert.strictEqual(sanitizeAgentName('-hello-'), 'hello');
    assert.strictEqual(sanitizeAgentName('---hello---'), 'hello');
  });

  it('handles special characters only', () => {
    assert.strictEqual(sanitizeAgentName('!!!'), 'agent');
    assert.strictEqual(sanitizeAgentName('---'), 'agent');
    assert.strictEqual(sanitizeAgentName('@@@'), 'agent');
  });

  it('handles mixed alphanumeric with special chars', () => {
    assert.strictEqual(sanitizeAgentName('hello!@#world'), 'hello-world');
    assert.strictEqual(sanitizeAgentName('Agent-123'), 'agent-123');
    assert.strictEqual(sanitizeAgentName('MY_AGENT_2024'), 'my-agent-2024');
  });

  it('handles unicode and non-ASCII characters', () => {
    assert.strictEqual(sanitizeAgentName('café'), 'caf');
    assert.strictEqual(sanitizeAgentName('日本語'), 'agent');
    assert.strictEqual(sanitizeAgentName('hello-café-world'), 'hello-world');
  });

  it('handles leading/trailing spaces and special chars', () => {
    assert.strictEqual(sanitizeAgentName('  hello  '), 'hello');
    assert.strictEqual(sanitizeAgentName('!!!hello!!!'), 'hello');
  });

  it('preserves numbers', () => {
    assert.strictEqual(sanitizeAgentName('agent123'), 'agent123');
    assert.strictEqual(sanitizeAgentName('123'), '123');
    assert.strictEqual(sanitizeAgentName('Agent-2024'), 'agent-2024');
  });

  it('results in "agent" for all-special-char strings after normalization', () => {
    assert.strictEqual(sanitizeAgentName('___'), 'agent');
    assert.strictEqual(sanitizeAgentName('   '), 'agent');
  });
});

describe('buildAgentTitle', () => {
  it('combines sanitized agent name with base title', () => {
    assert.strictEqual(buildAgentTitle('my-agent', 'Task Title'), '[my-agent] Task Title');
  });

  it('sanitizes agent name when building title', () => {
    assert.strictEqual(buildAgentTitle('MY_AGENT', 'Task Title'), '[my-agent] Task Title');
    assert.strictEqual(buildAgentTitle('--agent--', 'Task Title'), '[agent] Task Title');
  });

  it('uses agent name as suffix if base title is null', () => {
    assert.strictEqual(buildAgentTitle('my-agent', null), '[my-agent] my-agent');
  });

  it('uses just sanitized name if both title and agent name are null', () => {
    assert.strictEqual(buildAgentTitle(null, null), '[agent]');
  });

  it('uses agent name as suffix if both are present', () => {
    assert.strictEqual(buildAgentTitle('my-agent', 'Base Title'), '[my-agent] Base Title');
  });

  it('handles edge cases with special characters in agent name', () => {
    assert.strictEqual(buildAgentTitle('!!!', 'Task'), '[agent] Task');
    assert.strictEqual(buildAgentTitle('my@agent', 'Task'), '[my-agent] Task');
  });

  it('preserves base title exactly as provided', () => {
    assert.strictEqual(buildAgentTitle('agent', 'My Task [with] Special (chars)'), '[agent] My Task [with] Special (chars)');
  });
});
