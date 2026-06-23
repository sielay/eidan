// SPDX-License-Identifier: AGPL-3.0-or-later
// Owns plugin_db.* — the per-user database-connection registry. No password ever lands here; each
// is sealed in the vault (eidan.secrets_vault) under the connection's `pass_key`. This table holds
// only the name and the non-secret connection coordinates (driver/host/port/database/username plus
// a free-form `options` jsonb for ssl/authSource/replicaSet/srv flags) and that key ref. Modeled on
// the eidan mail integration's account registry; principal-stamped like core's storage/memory plugins
// so RLS stays consistent if it's ever added.
//
// NB this is the registry of *which* databases the agent may reach, NOT the eidan control-plane DB.
// The control-plane handle (EIDAN_DATABASE_URL) is where this registry table itself lives; the rows
// describe arbitrary third-party databases the operator has connected.
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export type Driver = 'postgres' | 'mongodb';

export interface ConnectionRow {
  id: string;
  name: string;
  slug: string;
  driver: Driver;
  host: string;
  port: number;
  database: string;
  username: string;
  options: Record<string, unknown>;
  pass_key: string;
}

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

// A momentarily-saturated connection pooler (Supabase session mode caps clients at pool_size; many
// plugins booting across >1 engine machine can exhaust it) surfaces as one of these. They are
// transient — retrying after the boot stampede clears lets the plugin load instead of being dropped.
function isTransientConnError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code ?? '';
  return (
    /EMAXCONNSESSION|max clients|too many clients|Connection terminated|timeout/i.test(msg) ||
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', '53300', '08006', '57P03'].includes(code)
  );
}

export class Registry {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    // Lean pool: this is a low-traffic registry (occasional single-row reads/writes), so cap the
    // client count low and reap idle clients quickly — the bundle adds minimal steady-state load to
    // the shared pooler rather than the default 10.
    this.pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
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

  // Idempotent: the plugin creates its own schema on first boot, so a drop-in install needs no
  // separate migration step (the tracked sql/ mirrors this for the migrate runner). Keep in sync
  // with sql/0001_db.sql. Retries a transiently-saturated pooler with backoff so a boot-time
  // connection stampede doesn't get the whole plugin dropped (matbot unloads a plugin whose setup()
  // throws); the durable fix is a transaction-mode pooler / higher pool_size on EIDAN_DATABASE_URL.
  async ensureSchema(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.ensureSchemaOnce();
      } catch (e) {
        if (attempt >= 5 || !isTransientConnError(e)) throw e;
        await new Promise((r) => setTimeout(r, attempt * 1000).unref());
      }
    }
  }

  private async ensureSchemaOnce(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('create schema if not exists plugin_db');
      await c.query(
        `create table if not exists plugin_db.connections (
           id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id     uuid NOT NULL,
           name        text NOT NULL,
           slug        text NOT NULL,
           driver      text NOT NULL,
           host        text NOT NULL,
           port        integer NOT NULL,
           database    text NOT NULL DEFAULT '',
           username    text NOT NULL DEFAULT '',
           options     jsonb NOT NULL DEFAULT '{}'::jsonb,
           pass_key    text NOT NULL DEFAULT '',
           status      text NOT NULL DEFAULT 'active',
           created_at  timestamptz NOT NULL DEFAULT now(),
           updated_at  timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await c.query(
        `create unique index if not exists uq_db_user_slug
           on plugin_db.connections (user_id, slug) where status = 'active'`,
      );
      await c.query('create index if not exists idx_db_user on plugin_db.connections (user_id)');
    } finally {
      c.release();
    }
  }

  // The current user's active connections (resolved from the ambient matbot Principal).
  async listConnections(): Promise<ConnectionRow[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, name, slug, driver, host, port, database, username, options, pass_key
           from plugin_db.connections
          where user_id = $1 and status = 'active'
          order by created_at`,
        [p.id],
      );
      return r.rows as ConnectionRow[];
    });
  }

  // One connection by id, scoped to the current principal (the test endpoint resolves the row this
  // way before pinging it). Returns undefined when there is no principal or no such active row.
  async getConnectionById(id: string): Promise<ConnectionRow | undefined> {
    const p = tryCurrentPrincipal();
    if (!p) return undefined;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, name, slug, driver, host, port, database, username, options, pass_key
           from plugin_db.connections
          where id = $1 and user_id = $2 and status = 'active'`,
        [id, p.id],
      );
      return r.rows[0] as ConnectionRow | undefined;
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
