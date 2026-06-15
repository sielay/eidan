// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

// Principal-stamping transaction helper (mirrors @eidandev/memory): per-user reads/writes run with
// eidan.current_user_id set from the ambient Principal. Routines also scope every statement by an
// explicit user_id predicate, so isolation holds with or without RLS policies. The cross-user poll
// loop uses the plain `query` path (no principal) to scan every owner's routines.
export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async withPrincipalTx<R>(fn: (q: Q) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const p = tryCurrentPrincipal();
      if (p) await client.query("select set_config('eidan.current_user_id', $1, true)", [p.id]);
      const q: Q = (text, params) => client.query(text, params as unknown[]);
      const r = await fn(q);
      await client.query('commit');
      return r;
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
    return this.pool.query(text, params as unknown[]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
