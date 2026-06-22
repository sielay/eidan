// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';

// Sage's own Postgres handle. Mirrors @eidandev/jobs' Db: a pool + a tx helper for the
// lease's FOR UPDATE / ON CONFLICT writes. The sage tables (sage.repos / repo_locks /
// pr_iterations) are node-scoped loop bookkeeping — no RLS, no ambient principal.
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
