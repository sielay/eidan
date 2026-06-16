// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoutes } from './notify.js';

describe('loadRoutes', () => {
  it('returns an empty map for absent/blank input', () => {
    assert.equal(loadRoutes(undefined).size, 0);
    assert.equal(loadRoutes('').size, 0);
    assert.equal(loadRoutes('   ').size, 0);
  });

  it('returns an empty map for malformed JSON (fail-soft, no throw)', () => {
    assert.equal(loadRoutes('{not json').size, 0);
    assert.equal(loadRoutes('[]nope').size, 0);
  });

  it('returns an empty map for non-object JSON', () => {
    assert.equal(loadRoutes('42').size, 0);
    assert.equal(loadRoutes('"a string"').size, 0);
    assert.equal(loadRoutes('null').size, 0);
  });

  it('parses topic -> {channel, target}', () => {
    const r = loadRoutes('{"routine":{"channel":"slack","target":"#eidan"},"job.update":{"channel":"telegram","target":"123"}}');
    assert.equal(r.size, 2);
    assert.deepEqual(r.get('routine'), { channel: 'slack', target: '#eidan' });
    assert.deepEqual(r.get('job.update'), { channel: 'telegram', target: '123' });
  });

  it('keeps a route with no target (target is optional, omitted not undefined)', () => {
    const r = loadRoutes('{"node.startup":{"channel":"slack"}}');
    assert.deepEqual(r.get('node.startup'), { channel: 'slack' });
    assert.ok(!('target' in (r.get('node.startup') as object)));
  });

  it('skips routes missing a string channel', () => {
    const r = loadRoutes('{"ok":{"channel":"slack"},"bad1":{"target":"#x"},"bad2":{"channel":42}}');
    assert.equal(r.size, 1);
    assert.ok(r.has('ok'));
    assert.ok(!r.has('bad1'));
    assert.ok(!r.has('bad2'));
  });

  it('skips non-object route specs', () => {
    const r = loadRoutes('{"ok":{"channel":"slack"},"bad":"slack"}');
    assert.equal(r.size, 1);
    assert.ok(r.has('ok'));
    assert.ok(!r.has('bad'));
  });
});
