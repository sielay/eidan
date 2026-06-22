// SPDX-License-Identifier: AGPL-3.0-or-later
// Owns plugin_logs.* — the per-user log-source registry. No API token ever lands here; each is
// sealed in the vault (eidan.secrets_vault) under the source's `token_key`. This table holds only
// the name, the provider, and the non-secret coordinates (a free-form `config` jsonb carrying
// project/app/team/base-url per provider) and that key ref. Modeled on the db/mail bundles'
// registries; principal-stamped like core's storage/memory plugins so RLS stays consistent.
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export type Provider = 'vercel' | 'fly' | 'heroku' | 'betterstack';

export interface SourceRow {
  id: string;
  name: string;
  slug: string;
  provider: Provider;
  config: Record<string, unknown>;
  token_key: string;
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
    // Lean pool: low-traffic registry, so cap clients low and reap idle ones quickly — minimal
    // steady-state load on the shared pooler rather than the default 10.
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

  // Idempotent: the plugin creates its own schema on first boot. Keep in sync with sql/0001_logs.sql.
  // Retries a transiently-saturated pooler with backoff so a boot-time connection stampede doesn't
  // get the whole plugin dropped (matbot unloads a plugin whose setup() throws).
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
      await c.query('create schema if not exists plugin_logs');
      await c.query(
        `create table if not exists plugin_logs.sources (
           id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id     uuid NOT NULL,
           name        text NOT NULL,
           slug        text NOT NULL,
           provider    text NOT NULL,
           config      jsonb NOT NULL DEFAULT '{}'::jsonb,
           token_key   text NOT NULL DEFAULT '',
           status      text NOT NULL DEFAULT 'active',
           created_at  timestamptz NOT NULL DEFAULT now(),
           updated_at  timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await c.query(
        `create unique index if not exists uq_logs_user_slug
           on plugin_logs.sources (user_id, slug) where status = 'active'`,
      );
      await c.query('create index if not exists idx_logs_user on plugin_logs.sources (user_id)');
    } finally {
      c.release();
    }
  }

  async listSources(): Promise<SourceRow[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, name, slug, provider, config, token_key
           from plugin_logs.sources
          where user_id = $1 and status = 'active'
          order by created_at`,
        [p.id],
      );
      return r.rows as SourceRow[];
    });
  }

  // One source by id, scoped to the current principal (the test endpoint resolves the row this way
  // before probing it). Returns undefined when there is no principal or no such active row.
  async getSourceById(id: string): Promise<SourceRow | undefined> {
    const p = tryCurrentPrincipal();
    if (!p) return undefined;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, name, slug, provider, config, token_key
           from plugin_logs.sources
          where id = $1 and user_id = $2 and status = 'active'`,
        [id, p.id],
      );
      return r.rows[0] as SourceRow | undefined;
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
