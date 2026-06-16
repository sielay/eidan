// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitText } from './bot.js';

const chunks = (text: string, max?: number): string[] => [...splitText(text, max)];

describe('splitText', () => {
  it('yields the whole string unchanged when within the limit', () => {
    assert.deepEqual(chunks('hello', 10), ['hello']);
    assert.deepEqual(chunks('', 10), ['']);
    assert.deepEqual(chunks('exactlyten', 10), ['exactlyten']); // length === max
  });

  it('splits on a word boundary, keeping the space at the end of a chunk', () => {
    assert.deepEqual(chunks('hello world foo', 10), ['hello ', 'world ', 'foo']);
  });

  it('splits on a newline boundary', () => {
    assert.deepEqual(chunks('aaaa\nbbbb\ncccc', 6), ['aaaa\n', 'bbbb\n', 'cccc']);
  });

  it('hard-splits a single over-long token with no boundary', () => {
    assert.deepEqual(chunks('abcdefghijklmno', 10), ['abcdefghij', 'klmno']);
  });

  // Invariants that must hold for any input/limit.
  for (const [text, max] of [
    ['hello world foo bar baz qux', 10],
    ['nospacesatallhereisalongword', 7],
    ['line one\nline two\nline three', 9],
    ['a'.repeat(100), 16],
    ['word ' .repeat(50), 13],
  ] as Array<[string, number]>) {
    it(`preserves content and respects the cap (len=${text.length}, max=${max})`, () => {
      const parts = chunks(text, max);
      assert.equal(parts.join(''), text, 'chunks must rejoin to the original');
      for (const p of parts) {
        assert.ok(p.length <= max, `chunk "${p}" exceeds max ${max}`);
        assert.ok(p.length > 0, 'no empty chunk (progress guaranteed)');
      }
    });
  }

  it('uses the Telegram 4096 default', () => {
    const long = 'x'.repeat(5000);
    const parts = chunks(long);
    assert.ok(parts.every((p) => p.length <= 4096));
    assert.equal(parts.join(''), long);
  });
});
