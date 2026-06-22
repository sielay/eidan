// SPDX-License-Identifier: AGPL-3.0-or-later
// Throwaway runtime smoke for the pure logic — verifies the module graph loads and the slug/key
// derivation, connection picker, and Mongo URI builder behave. No DB, no network. Run with:
//   node --import tsx packages/db/smoke.test.mts
import assert from 'node:assert/strict';
import { slugify, passKey, pickConnection } from './src/config.ts';
import { mongoUri } from './src/drivers/mongodb.ts';
import type { ConnectionRow } from './src/registry.ts';

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`  ✓ ${name}`); };

// slugify + passKey
assert.equal(slugify('Prod Analytics DB!'), 'prod_analytics_db');
assert.equal(slugify('   '), 'connection');
assert.equal(passKey(slugify('Prod Analytics DB!')), 'EIDAN_DB_PASS_prod_analytics_db');
ok('slugify normalises and passKey derives the vault key');

const row = (over: Partial<ConnectionRow>): ConnectionRow => ({
  id: 'id', name: 'Main', slug: 'main', driver: 'postgres', host: 'h', port: 5432,
  database: 'app', username: 'u', options: {}, pass_key: 'EIDAN_DB_PASS_main', ...over,
});

// pickConnection — single auto-picks, name/slug match, ambiguity returns undefined
const a = row({ name: 'Analytics', slug: 'analytics' });
const b = row({ name: 'Billing', slug: 'billing' });
assert.equal(pickConnection([a], undefined)?.name, 'Analytics'); // sole connection
assert.equal(pickConnection([a, b], undefined), undefined);      // ambiguous → must name one
assert.equal(pickConnection([a, b], 'billing')?.name, 'Billing');
assert.equal(pickConnection([a, b], 'Analytics')?.name, 'Analytics');
assert.equal(pickConnection([a, b], 'nope'), undefined);
ok('pickConnection: sole auto, name/slug match, ambiguity/miss → undefined');

// mongoUri — standard + srv + option passthrough + special-char password encoding
assert.equal(
  mongoUri(row({ driver: 'mongodb', host: 'db.local', port: 27017, database: 'app', username: 'me' }), 'p@ss/w:rd'),
  'mongodb://me:p%40ss%2Fw%3Ard@db.local:27017/app',
);
assert.equal(
  mongoUri(row({ driver: 'mongodb', host: 'cluster.mongodb.net', port: 27017, database: 'app', username: 'me', options: { srv: true, authSource: 'admin' } }), 'pw'),
  'mongodb+srv://me:pw@cluster.mongodb.net/app?authSource=admin',
);
assert.equal(
  mongoUri(row({ driver: 'mongodb', host: 'h', port: 27017, database: '', username: '', options: {} }), ''),
  'mongodb://h:27017/',
);
ok('mongoUri builds standard/srv URIs, percent-encodes creds, passes options through');

console.log(`\n${n} smoke groups passed`);
