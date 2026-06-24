// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure unit tests for slug + vault-key derivation. No pg/fetch imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  normalizeHost,
  clientKey,
  tokenKey,
  refreshKey,
  hostAppKey,
  packClient,
  parseClient,
} from './keys.js';

test('slugify lowercases, collapses non-alnum, trims, caps length', () => {
  assert.equal(slugify('Personal'), 'personal');
  assert.equal(slugify('  Work Account!! '), 'work_account');
  assert.equal(slugify('@@@'), 'account');
  assert.equal(slugify('a'.repeat(60)).length, 40);
});

test('normalizeHost strips scheme/path/trailing slash and lowercases', () => {
  assert.equal(normalizeHost('https://Mastodon.Social/'), 'mastodon.social');
  assert.equal(normalizeHost('fosstodon.org'), 'fosstodon.org');
  assert.equal(normalizeHost('http://example.com/@user'), 'example.com');
  assert.equal(normalizeHost(''), '');
});

test('vault key derivation is stable and provider-prefixed', () => {
  assert.equal(clientKey('x', 'personal'), 'EIDAN_X_CLIENT_personal');
  assert.equal(tokenKey('x', 'personal'), 'EIDAN_X_TOKEN_personal');
  assert.equal(refreshKey('linkedin', 'work'), 'EIDAN_LINKEDIN_REFRESH_work');
  assert.equal(hostAppKey('mastodon', 'https://Fosstodon.org/'), 'EIDAN_MASTODON_HOSTAPP_fosstodon_org');
});

test('packClient/parseClient round-trip; parseClient rejects junk', () => {
  const raw = packClient({ clientId: 'id', clientSecret: 'sec' });
  assert.deepEqual(parseClient(raw), { clientId: 'id', clientSecret: 'sec' });
  assert.equal(parseClient('not json'), null);
  assert.equal(parseClient('{"client_id":"id"}'), null); // missing secret
});
