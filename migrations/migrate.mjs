// SPDX-License-Identifier: AGPL-3.0-or-later
// Tiny SQL migration runner (no Alembic / Python). Applies the ordered .sql files under sql/ that
// haven't run yet, tracking them in eidan._migrations. Idempotent.
//
//   EIDAN_DATABASE_URL=postgres://...@host/db node migrations/migrate.mjs
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (!url) {
  console.error('[migrate] EIDAN_DATABASE_URL (or DATABASE_URL) required');
  process.exit(1);
}

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), 'sql');
const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query('create schema if not exists eidan');
  await client.query(
    'create table if not exists eidan._migrations (version text primary key, applied_at timestamptz not null default now())',
  );
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const f of files) {
    const done = await client.query('select 1 from eidan._migrations where version = $1', [f]);
    if (done.rowCount) continue;
    console.log(`[migrate] applying ${f}`);
    await client.query('begin');
    try {
      await client.query(await readFile(join(sqlDir, f), 'utf8'));
      await client.query('insert into eidan._migrations(version) values ($1)', [f]);
      await client.query('commit');
      applied++;
    } catch (e) {
      await client.query('rollback');
      console.error(`[migrate] ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
  console.log(`[migrate] up to date (${applied} applied this run, ${files.length} total)`);
} finally {
  client.release();
  await pool.end();
}
