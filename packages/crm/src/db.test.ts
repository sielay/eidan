// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrmDb } from './db.js';

// Basic smoke test for the CrmDb schema — ensures tables exist and basic queries work.
test('CrmDb.ensureSchema creates tables', async () => {
  const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    console.log('(skipped: no database configured)');
    return;
  }

  const db = new CrmDb(url);
  await db.ensureSchema();
  const result = await db.pool.query(
    `select table_name from information_schema.tables where table_schema = $1 order by table_name`,
    [db.schema],
  );
  const tables = (result.rows as Array<{ table_name: string }>).map((r) => r.table_name).sort();
  assert.deepEqual(tables, ['activities', 'contacts', 'deals']);
  await db.close();
});
