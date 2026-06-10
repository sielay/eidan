// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';

// The ledger sets user_id explicitly and eidan.llm_calls has no RLS in core, so no principal GUC.
export class Db {
  readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  query(text: string, params?: unknown[]): Promise<pg.QueryResult> { return this.pool.query(text, params as unknown[]); }
  async close(): Promise<void> { await this.pool.end(); }
}
