// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-plugin account registry over plugin_<name>.accounts. No tokens land here: the OAuth client
// id/secret, the access token and the durable refresh token are all sealed in the vault under the
// keys recorded in *_vault_key columns. This table holds only the display name, the connected
// identity (handle/id), the optional instance host, the vault key names, and the access-token
// expiry. Principal-stamped (eidan.current_user_id) so RLS stays consistent across plugin schemas.
//
// One uniform shape serves every integration (google + the social-* plugins). `host` is '' except
// for per-host providers (mastodon). The schema is created idempotently on first boot and evolved
// with add-column-if-not-exists, so an existing table (e.g. google's live plugin_google.accounts)
// gains the new columns without a migration.
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { normalizeHost } from './keys.js';

export interface ConnAccount {
  id: string;
  name: string;
  slug: string;
  host: string;
  external_handle: string;
  external_id: string;
  client_vault_key: string;
  token_vault_key: string;
  refresh_vault_key: string;
  token_expires_at: Date | null;
  status: string;
  context: string; // operator-authored free text about this account, surfaced to the agent
  metadata: Record<string, unknown>;
}

export interface RegistryConfig {
  schema: string; // e.g. 'plugin_social_x'
  hasHost?: boolean; // mastodon: include host in slug uniqueness + a per-host app-cred cache table
}

// The subset of the registry the OAuth server + resolver depend on. Lets us keep the surface small
// and testable (an in-memory fake implements it in unit tests).
export interface AccountStore {
  listAccounts(): Promise<ConnAccount[]>;
  getAccountById(id: string): Promise<ConnAccount | null>;
  setPending(id: string, patch?: { metadata?: Record<string, unknown> }): Promise<void>;
  setActive(
    id: string,
    fields: {
      external_handle?: string;
      external_id?: string;
      token_expires_at?: Date | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void>;
  updateExpiry(id: string, expiresAt: Date | null): Promise<void>;
}

type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

const COLS =
  'id, name, slug, host, external_handle, external_id, client_vault_key, token_vault_key, refresh_vault_key, token_expires_at, status, context, metadata';

export class Registry implements AccountStore {
  readonly pool: pg.Pool;
  private readonly schema: string;
  private readonly hasHost: boolean;

  constructor(connectionString: string, cfg: RegistryConfig) {
    this.pool = new pg.Pool({ connectionString });
    this.schema = cfg.schema;
    this.hasHost = cfg.hasHost ?? false;
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

  async ensureSchema(): Promise<void> {
    const s = this.schema;
    const c = await this.pool.connect();
    try {
      await c.query(`create schema if not exists ${s}`);
      await c.query(
        `create table if not exists ${s}.accounts (
           id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id           uuid NOT NULL,
           name              text NOT NULL,
           slug              text NOT NULL,
           host              text NOT NULL DEFAULT '',
           external_handle   text NOT NULL DEFAULT '',
           external_id       text NOT NULL DEFAULT '',
           client_vault_key  text NOT NULL DEFAULT '',
           token_vault_key   text NOT NULL DEFAULT '',
           refresh_vault_key text NOT NULL DEFAULT '',
           token_expires_at  timestamptz,
           status            text NOT NULL DEFAULT 'active',
           context           text NOT NULL DEFAULT '',
           metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
           created_at        timestamptz NOT NULL DEFAULT now(),
           updated_at        timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Evolve a pre-existing table (e.g. google's live one) additively.
      for (const col of [
        "host text NOT NULL DEFAULT ''",
        "external_handle text NOT NULL DEFAULT ''",
        "external_id text NOT NULL DEFAULT ''",
        "token_vault_key text NOT NULL DEFAULT ''",
        'token_expires_at timestamptz',
        "context text NOT NULL DEFAULT ''",
        "metadata jsonb NOT NULL DEFAULT '{}'::jsonb",
      ]) {
        await c.query(`alter table ${s}.accounts add column if not exists ${col}`);
      }
      // Back-fill external_handle from a legacy `email` column when present (google), so connected
      // accounts keep their displayed identity after adopting the kit. No-op when no email column.
      await c.query(
        `do $$ begin
           if exists (select 1 from information_schema.columns
                      where table_schema = '${s}' and table_name = 'accounts' and column_name = 'email') then
             update ${s}.accounts set external_handle = email
              where external_handle = '' and email is not null and email <> '';
           end if;
         end $$`,
      );
      // Reserve the slug across live states (active + in-flight pending); archived rows free it.
      const uniqCols = this.hasHost ? '(user_id, host, slug)' : '(user_id, slug)';
      await c.query(
        `create unique index if not exists uq_${s}_user_slug
           on ${s}.accounts ${uniqCols} where status in ('active', 'pending')`,
      );
      await c.query(`create index if not exists idx_${s}_user on ${s}.accounts (user_id)`);

      // Named OAuth apps: a user can register MANY client-credential sets per provider (e.g. a
      // personal app and a work app), and each connection references one. The client id/secret are
      // sealed in the vault under client_vault_key; this table just names them. (mastodon uses its
      // per-host host_apps instead; bluesky has no app — the table is simply unused for them.)
      await c.query(
        `create table if not exists ${s}.apps (
           id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id          uuid NOT NULL,
           name             text NOT NULL,
           type             text NOT NULL DEFAULT '',
           client_vault_key text NOT NULL,
           status           text NOT NULL DEFAULT 'active',
           created_at       timestamptz NOT NULL DEFAULT now(),
           updated_at       timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await c.query(`alter table ${s}.apps add column if not exists type text NOT NULL DEFAULT ''`);
      await c.query(
        `create unique index if not exists uq_${s}_app_name on ${s}.apps (user_id, name) where status = 'active'`,
      );

      if (this.hasHost) {
        // Per-host (mastodon) app-credential cache: register the OAuth app with each instance once,
        // reuse for every account on that host. The client id/secret are sealed in the vault under
        // client_vault_key; this table just records which instances have a registered app.
        await c.query(
          `create table if not exists ${s}.host_apps (
             id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
             user_id          uuid NOT NULL,
             host             text NOT NULL,
             client_vault_key text NOT NULL,
             created_at       timestamptz NOT NULL DEFAULT now(),
             UNIQUE (user_id, host)
           )`,
        );
      }
    } finally {
      c.release();
    }
  }

  private rowToAccount(r: Record<string, unknown>): ConnAccount {
    return {
      id: String(r['id']),
      name: String(r['name']),
      slug: String(r['slug']),
      host: String(r['host'] ?? ''),
      external_handle: String(r['external_handle'] ?? ''),
      external_id: String(r['external_id'] ?? ''),
      client_vault_key: String(r['client_vault_key'] ?? ''),
      token_vault_key: String(r['token_vault_key'] ?? ''),
      refresh_vault_key: String(r['refresh_vault_key'] ?? ''),
      token_expires_at: (r['token_expires_at'] as Date | null) ?? null,
      status: String(r['status']),
      context: String(r['context'] ?? ''),
      metadata: (r['metadata'] as Record<string, unknown>) ?? {},
    };
  }

  async listAccounts(): Promise<ConnAccount[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${COLS} from ${this.schema}.accounts
          where user_id = $1 and status = 'active' order by created_at`,
        [p.id],
      );
      return (r.rows as Record<string, unknown>[]).map((row) => this.rowToAccount(row));
    });
  }

  async getAccountById(id: string): Promise<ConnAccount | null> {
    const p = tryCurrentPrincipal();
    if (!p) return null;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${COLS} from ${this.schema}.accounts where id = $1 and user_id = $2`,
        [id, p.id],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? this.rowToAccount(row) : null;
    });
  }

  async setPending(id: string, patch?: { metadata?: Record<string, unknown> }): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      if (patch?.metadata) {
        await q(
          `update ${this.schema}.accounts
              set status = 'pending', metadata = metadata || $3::jsonb, updated_at = now()
            where id = $1 and user_id = $2`,
          [id, p.id, JSON.stringify(patch.metadata)],
        );
      } else {
        await q(
          `update ${this.schema}.accounts set status = 'pending', updated_at = now()
            where id = $1 and user_id = $2`,
          [id, p.id],
        );
      }
    });
  }

  async setActive(
    id: string,
    fields: {
      external_handle?: string;
      external_id?: string;
      token_expires_at?: Date | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(
        `update ${this.schema}.accounts
            set status = 'active',
                external_handle = coalesce($3, external_handle),
                external_id = coalesce($4, external_id),
                token_expires_at = $5,
                metadata = metadata || $6::jsonb,
                updated_at = now()
          where id = $1 and user_id = $2`,
        [
          id,
          p.id,
          fields.external_handle ?? null,
          fields.external_id ?? null,
          fields.token_expires_at ?? null,
          JSON.stringify(fields.metadata ?? {}),
        ],
      );
    });
  }

  // Rename a connection and/or set its agent-facing context. The slug is deliberately NOT changed —
  // the vault keys (token/refresh) are derived from it, so it must stay stable across a rename.
  async updateMeta(id: string, fields: { name?: string; context?: string }): Promise<boolean> {
    const p = tryCurrentPrincipal();
    if (!p) return false;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `update ${this.schema}.accounts
            set name = coalesce($3, name), context = coalesce($4, context), updated_at = now()
          where id = $1 and user_id = $2 and status in ('active', 'pending')`,
        [id, p.id, fields.name ?? null, fields.context ?? null],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async updateExpiry(id: string, expiresAt: Date | null): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(
        `update ${this.schema}.accounts set token_expires_at = $3, updated_at = now()
          where id = $1 and user_id = $2`,
        [id, p.id, expiresAt],
      );
    });
  }

  // Per-host app-credential cache (mastodon). Returns the sealed client_vault_key for an instance,
  // or null when no app has been registered with it yet.
  async getHostApp(host: string): Promise<{ client_vault_key: string } | null> {
    const p = tryCurrentPrincipal();
    if (!p) return null;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select client_vault_key from ${this.schema}.host_apps where user_id = $1 and host = $2`,
        [p.id, normalizeHost(host)],
      );
      const row = r.rows[0] as { client_vault_key: string } | undefined;
      return row ?? null;
    });
  }

  async putHostApp(host: string, clientVaultKey: string): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(
        `insert into ${this.schema}.host_apps (user_id, host, client_vault_key)
         values ($1, $2, $3)
         on conflict (user_id, host) do update set client_vault_key = excluded.client_vault_key`,
        [p.id, normalizeHost(host), clientVaultKey],
      );
    });
  }

  async deleteHostApp(host: string): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(`delete from ${this.schema}.host_apps where user_id = $1 and host = $2`, [p.id, normalizeHost(host)]);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
