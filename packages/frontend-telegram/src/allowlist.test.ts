// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadAllowlist, normaliseId, resolvePrincipal } from './allowlist.js';

describe('normaliseId', () => {
  it('accepts integer numbers and numeric strings, canonicalising to decimal', () => {
    assert.equal(normaliseId(123), '123');
    assert.equal(normaliseId('123'), '123');
    assert.equal(normaliseId(' 123 '), '123');
    assert.equal(normaliseId('007'), '7');
    assert.equal(normaliseId(-456), '-456');
  });
  it('rejects non-integers and non-numeric strings', () => {
    assert.equal(normaliseId(1.5), undefined);
    assert.equal(normaliseId('abc'), undefined);
    assert.equal(normaliseId('12a'), undefined);
    assert.equal(normaliseId(''), undefined);
  });
});

describe('loadAllowlist', () => {
  it('returns an empty map for absent or blank input (fail-closed)', () => {
    assert.equal(loadAllowlist(undefined).size, 0);
    assert.equal(loadAllowlist('').size, 0);
    assert.equal(loadAllowlist('   ').size, 0);
  });
  it('parses a JSON object of telegram id -> principal id', () => {
    const a = loadAllowlist('{"123":"user-a","456":"user-b"}');
    assert.equal(a.size, 2);
    assert.equal(a.get('123'), 'user-a');
    assert.equal(a.get('456'), 'user-b');
  });
  it('normalises numeric-looking keys and trims values', () => {
    const a = loadAllowlist('{"007":"  user-a  "}');
    assert.equal(a.get('7'), 'user-a');
  });
  it('returns empty on malformed JSON, arrays, or non-objects (no throw)', () => {
    assert.equal(loadAllowlist('{not json').size, 0);
    assert.equal(loadAllowlist('[1,2,3]').size, 0);
    assert.equal(loadAllowlist('"str"').size, 0);
    assert.equal(loadAllowlist('null').size, 0);
  });
  it('skips entries with non-numeric keys or empty/non-string values', () => {
    const a = loadAllowlist('{"abc":"user-a","123":"","456":42,"789":"ok"}');
    assert.equal(a.size, 1);
    assert.equal(a.get('789'), 'ok');
  });
});

describe('resolvePrincipal', () => {
  const allow = loadAllowlist('{"111":"alice","222":"group-bot"}');

  it('rejects everyone when the allowlist is empty', () => {
    assert.equal(resolvePrincipal(new Map(), { fromId: 111, chatId: 111 }), undefined);
  });
  it('admits an allowlisted user id as a user principal', () => {
    assert.deepEqual(resolvePrincipal(allow, { fromId: 111, chatId: 999 }), { id: 'alice', type: 'user' });
  });
  it('admits via the chat id when the user id is not listed', () => {
    assert.deepEqual(resolvePrincipal(allow, { fromId: 888, chatId: 222 }), { id: 'group-bot', type: 'user' });
  });
  it('prefers the user id over the chat id', () => {
    const both = loadAllowlist('{"111":"alice","222":"group-bot"}');
    assert.deepEqual(resolvePrincipal(both, { fromId: 111, chatId: 222 }), { id: 'alice', type: 'user' });
  });
  it('rejects an unknown sender', () => {
    assert.equal(resolvePrincipal(allow, { fromId: 999, chatId: 999 }), undefined);
  });
  it('rejects a message with no sender id when only a user id is allowed', () => {
    assert.equal(resolvePrincipal(allow, { chatId: 999 }), undefined);
  });
});
