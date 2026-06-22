// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeckRenderError } from './render.js';

describe('DeckRenderError', () => {
  it('is an Error with name "DeckRenderError"', () => {
    const err = new DeckRenderError('test error');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'DeckRenderError');
    assert.equal(err.message, 'test error');
  });

  it('can be caught as an Error', () => {
    const err = new DeckRenderError('test');
    try {
      throw err;
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(e instanceof DeckRenderError);
    }
  });
});
