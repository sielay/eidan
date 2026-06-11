// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import type { Principal } from '@matatbread/matbot-plugin-api';

// A lazily-created pool for the REST read surface (conversation list / messages). Separate from
// @eidandev/storage-postgres's pool — this package serves the Next app's plain CRUD reads, which
// are not part of the matbot Store. Same EIDAN_DATABASE_URL.
let pool: pg.Pool | undefined;
function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) required for frontend-agui REST');
    pool = new pg.Pool({ connectionString: url });
  }
  return pool;
}

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

// Run fn in a transaction that stamps the ambient Principal into the LOCAL GUC so Postgres RLS
// scopes the reads (belt-and-braces: the REST handlers ALSO filter by user_id explicitly, so this
// is correct even when connected as a superuser that bypasses RLS).
export async function withPrincipal<R>(principal: Principal | undefined, fn: (q: Q) => Promise<R>): Promise<R> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    if (principal) await client.query("select set_config('eidan.current_user_id', $1, true)", [principal.id]);
    const q: Q = (text, params) => client.query(text, params as unknown[]);
    const r = await fn(q);
    await client.query('commit');
    client.release();
    return r;
  } catch (e) {
    // Guard the rollback: on a broken connection it throws and would mask the original error.
    try {
      await client.query('rollback');
    } catch {
      /* tx/connection already broken — keep the original error */
    }
    // Destroy a possibly-dirty connection (open tx) rather than return it to the pool.
    client.release(e instanceof Error ? e : true);
    throw e;
  }
}
