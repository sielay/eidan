// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for the venture-resource provider adapter registry (Track V1/V2). Pure logic — no
// matbot/db imports — so it runs under the root `pnpm test` node:test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableProviders,
  availableProvidersByKind,
  getAdapter,
  isAvailable,
  isResourceKind,
  plannedProvidersByKind,
} from './providers.js';

test('V1: manual is available for every kind; social platforms are now connectable', () => {
  for (const kind of ['social_account', 'mailing_list', 'analytics_property'] as const) {
    assert.ok(isAvailable(kind, 'manual'));
  }
  // social_account: the live social-* plugins make these attachable (handle validated against the
  // connection registry at attach time). mailing_list / analytics_property are still manual-only.
  assert.deepEqual(availableProvidersByKind()['mailing_list'], ['manual']);
  assert.deepEqual(availableProvidersByKind()['analytics_property'], ['manual']);
  for (const p of ['x', 'linkedin', 'instagram', 'facebook', 'threads', 'bluesky', 'mastodon', 'youtube']) {
    assert.ok(isAvailable('social_account', p), `${p} should be available`);
  }
});

test('V1: providers without an adapter stay planned, not attachable', () => {
  // tiktok has no eidan social plugin yet → still planned.
  assert.ok(!isAvailable('social_account', 'tiktok'));
  assert.ok(!isAvailable('mailing_list', 'mailchimp'));
  assert.ok(!isAvailable('analytics_property', 'ga4'));
  assert.ok(plannedProvidersByKind()['social_account'].includes('tiktok'));
  assert.ok(plannedProvidersByKind()['mailing_list'].includes('mailchimp'));
  // a planned provider carries no resolver (no adapter yet)
  assert.equal(getAdapter('social_account', 'tiktok')?.resolveRef, undefined);
});

test('V1: unknown kinds/providers are rejected', () => {
  assert.ok(!isResourceKind('not_a_kind'));
  assert.ok(isResourceKind('social_account'));
  assert.ok(!isAvailable('social_account', 'myspace'));
});

test('V2: manual social handle is normalised (strip @, reject whitespace)', () => {
  const r = getAdapter('social_account', 'manual')!.resolveRef!;
  assert.deepEqual(r('@eidan_dev'), { ok: true, value: 'eidan_dev' });
  assert.deepEqual(r('  @eidan_dev  '), { ok: true, value: 'eidan_dev' });
  assert.deepEqual(r('https://x.com/eidan_dev'), { ok: true, value: 'https://x.com/eidan_dev' });
  assert.equal(r('two words').ok, false);
  assert.equal(r('   ').ok, false);
  assert.equal(r('@').ok, false);
});

test('V2: manual mailing/analytics names are trimmed, non-empty', () => {
  const m = getAdapter('mailing_list', 'manual')!.resolveRef!;
  assert.deepEqual(m('  Weekly Digest  '), { ok: true, value: 'Weekly Digest' });
  assert.equal(m('').ok, false);
  const a = getAdapter('analytics_property', 'manual')!.resolveRef!;
  assert.deepEqual(a('  prop-123 '), { ok: true, value: 'prop-123' });
});
