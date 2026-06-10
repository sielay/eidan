// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';

// The jobs queue is node-scoped, not user-scoped, so (unlike the memory backend) it needs no
// ambient-principal GUC — eidan.jobs has no RLS. Just a pool + a transaction helper for the
// FOR UPDATE SKIP LOCKED claim.
export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async tx<R>(fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const r = await fn((text, params) => client.query(text, params as unknown[]));
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
