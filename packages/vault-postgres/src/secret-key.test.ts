// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitSecretKey } from './secret-key.js';

describe('splitSecretKey', () => {
  it('puts a dot-less (flat env-style) name in scope "core"', () => {
    assert.deepEqual(splitSecretKey('EIDAN_IMAP_PASSWORD'), { scope: 'core', subkey: 'EIDAN_IMAP_PASSWORD' });
    assert.deepEqual(splitSecretKey(''), { scope: 'core', subkey: '' });
  });

  it('splits on the FIRST dot into scope + subkey', () => {
    assert.deepEqual(splitSecretKey('slack.bot_token'), { scope: 'slack', subkey: 'bot_token' });
    assert.deepEqual(splitSecretKey('google.oauth.client'), { scope: 'google', subkey: 'oauth.client' });
  });

  it('handles edge placements of the dot', () => {
    assert.deepEqual(splitSecretKey('.leading'), { scope: '', subkey: 'leading' });
    assert.deepEqual(splitSecretKey('trailing.'), { scope: 'trailing', subkey: '' });
    assert.deepEqual(splitSecretKey('.'), { scope: '', subkey: '' });
  });
});
