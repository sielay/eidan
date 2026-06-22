// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { guardResult, capFromEnv } from './src/guard.ts';

describe('guardResult', () => {
  it('leaves a small string untouched', () => {
    assert.equal(guardResult('hello', 50_000, 'http'), undefined);
  });

  it('leaves a small object untouched', () => {
    assert.equal(guardResult({ a: 1, b: [1, 2, 3] }, 50_000, 'http'), undefined);
  });

  it('truncates an oversized string to the cap + a notice', () => {
    const big = 'x'.repeat(60_000);
    const out = guardResult(big, 50_000, 'http');
    assert.ok(out, 'should replace');
    const text = out!.result as string;
    assert.ok(text.startsWith('x'.repeat(50_000)));
    assert.ok(text.includes('truncated by eidan tool-guard'));
    assert.ok(text.includes('"http"'));
    assert.ok(text.includes('10,000 omitted'));
  });

  it('truncates an oversized object (measured by its JSON length)', () => {
    const big = { blob: 'y'.repeat(60_000) };
    const out = guardResult(big, 50_000, 'http');
    assert.ok(out, 'should replace');
    assert.ok((out!.result as string).length < 60_100); // capped, not the full 60k+ payload
  });

  it('0 cap disables truncation', () => {
    assert.equal(guardResult('x'.repeat(99_999), 0, 'http'), undefined);
  });

  it('leaves unstringifiable results (circular) untouched', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    assert.equal(guardResult(circular, 10, 'http'), undefined);
  });
});

describe('capFromEnv', () => {
  it('defaults to 50000 when unset/empty', () => {
    assert.equal(capFromEnv({}), 50_000);
    assert.equal(capFromEnv({ EIDAN_TOOL_RESULT_MAX_CHARS: '' }), 50_000);
  });
  it('honours a valid override', () => {
    assert.equal(capFromEnv({ EIDAN_TOOL_RESULT_MAX_CHARS: '8000' }), 8_000);
    assert.equal(capFromEnv({ EIDAN_TOOL_RESULT_MAX_CHARS: '0' }), 0);
  });
  it('falls back to default on garbage / negative', () => {
    assert.equal(capFromEnv({ EIDAN_TOOL_RESULT_MAX_CHARS: 'abc' }), 50_000);
    assert.equal(capFromEnv({ EIDAN_TOOL_RESULT_MAX_CHARS: '-5' }), 50_000);
  });
});
