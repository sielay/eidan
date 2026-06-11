// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-only Postgres access for the Next route handlers (dashboards-from-Postgres half of the
// architecture). Lazily-pooled; every unit of work runs in a tx that stamps the authenticated user
// into the RLS GUC. The routes ALSO filter user_id explicitly, so reads are correct even when the
// connection string is a superuser that bypasses RLS.
import { Pool, type PoolClient } from "pg";

let pool: Pool | undefined;
function getPool(): Pool {
  if (!pool) {
    const url = process.env.EIDAN_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error("EIDAN_DATABASE_URL (or DATABASE_URL) required for the data routes");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export async function withUser<R>(userId: string, fn: (c: PoolClient) => Promise<R>): Promise<R> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('eidan.current_user_id', $1, true)", [userId]);
    const r = await fn(client);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? "");
}
