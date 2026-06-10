// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

// Every unit of work runs in a transaction that stamps the ambient matbot Principal into a
// LOCAL GUC, so Postgres RLS enforces tenant isolation with no app-level filtering. The
// principal is read here, never threaded — matbot's un-forgettable ambient propagation.
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
