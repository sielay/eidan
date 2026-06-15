// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';

// Plain pooled access. Telegram link/binding rows are keyed by explicit chat_id / user_id (no RLS
// predicate), and several paths run pre-auth (the /start token mint has no principal yet), so this
// plugin uses direct queries rather than the principal-stamping transaction helper.
export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
    return this.pool.query(text, params as unknown[]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
