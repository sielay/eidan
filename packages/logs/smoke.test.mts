// SPDX-License-Identifier: AGPL-3.0-or-later
// Throwaway runtime smoke for the pure logic — verifies the module graph loads and the slug/key
// derivation, source picker, and provider dispatch behave. No DB, no network. Run with:
//   node --import tsx packages/logs/smoke.test.mts
import assert from 'node:assert/strict';
import { slugify, tokenKey, pickSource } from './src/config.ts';
import { providerFetch, cfgStr } from './src/providers/index.ts';
import type { SourceRow } from './src/registry.ts';

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`  ✓ ${name}`); };

// slugify + tokenKey
assert.equal(slugify('Prod Web (Vercel)!'), 'prod_web_vercel');
assert.equal(slugify('   '), 'source');
assert.equal(tokenKey(slugify('Prod Web (Vercel)!')), 'EIDAN_LOG_TOKEN_prod_web_vercel');
ok('slugify normalises and tokenKey derives the vault key');

const row = (over: Partial<SourceRow>): SourceRow => ({
  id: 'id', name: 'Web', slug: 'web', provider: 'vercel', config: {}, token_key: 'EIDAN_LOG_TOKEN_web', ...over,
});

// pickSource — single auto-picks, name/slug match, ambiguity → undefined
const a = row({ name: 'Web', slug: 'web', provider: 'vercel' });
const b = row({ name: 'API', slug: 'api', provider: 'fly' });
assert.equal(pickSource([a], undefined)?.name, 'Web');
assert.equal(pickSource([a, b], undefined), undefined);
assert.equal(pickSource([a, b], 'api')?.provider, 'fly');
assert.equal(pickSource([a, b], 'Web')?.provider, 'vercel');
assert.equal(pickSource([a, b], 'nope'), undefined);
ok('pickSource: sole auto, name/slug match, ambiguity/miss → undefined');

// provider dispatch resolves a fetcher for every supported provider
for (const p of ['vercel', 'fly', 'heroku', 'betterstack'] as const) {
  assert.equal(typeof providerFetch(p), 'function');
}
ok('providerFetch resolves all four providers');

// cfgStr trims + tolerates non-strings
assert.equal(cfgStr({ app: '  my-app  ' }, 'app'), 'my-app');
assert.equal(cfgStr({ app: 123 }, 'app'), '');
assert.equal(cfgStr({}, 'missing'), '');
ok('cfgStr trims strings and returns "" for missing/non-string');

console.log(`\n${n} smoke groups passed`);
