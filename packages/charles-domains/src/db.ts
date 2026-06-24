// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export interface RegistrarAccount {
  id: string;
  user_id: string;
  registrar: string;
  name: string;
  key_vault_key: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface Domain {
  id: string;
  user_id: string;
  registrar: string;
  name: string;
  external_id: string | null;
  registrar_account_id: string | null;
  status: string;
  expires_at: Date | null;
  auto_renew: boolean | null;
  nameservers: string[] | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

export class DomainsDb {
  private readonly pool: pg.Pool;
  readonly schema = 'plugin_charles_domains';

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`create schema if not exists ${this.schema}`);
      await c.query(
        `create table if not exists ${this.schema}.registrar_accounts (
           id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id              uuid NOT NULL,
           registrar            text NOT NULL CHECK (registrar IN ('godaddy', 'cyberfolks')),
           name                 text NOT NULL,
           key_vault_key        text NOT NULL,
           status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
           created_at           timestamptz NOT NULL DEFAULT now(),
           updated_at           timestamptz NOT NULL DEFAULT now(),
           UNIQUE (user_id, registrar, name) WHERE status = 'active'
         )`,
      );
      await c.query(
        `create table if not exists ${this.schema}.domains (
           id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id              uuid NOT NULL,
           registrar            text NOT NULL CHECK (registrar IN ('godaddy', 'cyberfolks', 'manual')),
           name                 text NOT NULL,
           external_id          text,
           registrar_account_id uuid REFERENCES ${this.schema}.registrar_accounts(id),
           status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
           expires_at           timestamptz,
           auto_renew           boolean,
           nameservers          jsonb,
           metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
           created_at           timestamptz NOT NULL DEFAULT now(),
           updated_at           timestamptz NOT NULL DEFAULT now(),
           UNIQUE (user_id, lower(name)) WHERE status = 'active'
         )`,
      );
      await c.query(
        `create index if not exists idx_${this.schema}_domains_user on ${this.schema}.domains (user_id)`,
      );
      await c.query(
        `create index if not exists idx_${this.schema}_accounts_user on ${this.schema}.registrar_accounts (user_id)`,
      );
    } finally {
      c.release();
    }
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

  async listRegistrarAccounts(): Promise<RegistrarAccount[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, user_id, registrar, name, key_vault_key, status, created_at, updated_at
           from ${this.schema}.registrar_accounts
          where user_id = $1 and status = 'active'
          order by created_at`,
        [p.id],
      );
      return (r.rows as Record<string, unknown>[]).map((row) => ({
        id: String(row['id']),
        user_id: String(row['user_id']),
        registrar: String(row['registrar']),
        name: String(row['name']),
        key_vault_key: String(row['key_vault_key']),
        status: String(row['status']),
        created_at: row['created_at'] as Date,
        updated_at: row['updated_at'] as Date,
      }));
    });
  }

  async getRegistrarAccount(id: string): Promise<RegistrarAccount | null> {
    const p = tryCurrentPrincipal();
    if (!p) return null;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, user_id, registrar, name, key_vault_key, status, created_at, updated_at
           from ${this.schema}.registrar_accounts
          where id = $1 and user_id = $2 and status = 'active'`,
        [id, p.id],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: String(row['id']),
        user_id: String(row['user_id']),
        registrar: String(row['registrar']),
        name: String(row['name']),
        key_vault_key: String(row['key_vault_key']),
        status: String(row['status']),
        created_at: row['created_at'] as Date,
        updated_at: row['updated_at'] as Date,
      };
    });
  }

  async insertRegistrarAccount(registrar: string, name: string, keyVaultKey: string): Promise<RegistrarAccount> {
    const p = tryCurrentPrincipal();
    if (!p) throw new Error('no principal');
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.registrar_accounts (user_id, registrar, name, key_vault_key)
         values ($1, $2, $3, $4)
         returning id, user_id, registrar, name, key_vault_key, status, created_at, updated_at`,
        [p.id, registrar, name, keyVaultKey],
      );
      const row = r.rows[0] as Record<string, unknown>;
      return {
        id: String(row['id']),
        user_id: String(row['user_id']),
        registrar: String(row['registrar']),
        name: String(row['name']),
        key_vault_key: String(row['key_vault_key']),
        status: String(row['status']),
        created_at: row['created_at'] as Date,
        updated_at: row['updated_at'] as Date,
      };
    });
  }

  async listDomains(status?: string): Promise<Domain[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const where = status ? 'and status = $2' : '';
      const params = status ? [p.id, status] : [p.id];
      const r = await q(
        `select id, user_id, registrar, name, external_id, registrar_account_id, status,
                expires_at, auto_renew, nameservers, metadata, created_at, updated_at
           from ${this.schema}.domains
          where user_id = $1 ${where}
          order by created_at`,
        params,
      );
      return (r.rows as Record<string, unknown>[]).map((row) => this.rowToDomain(row));
    });
  }

  async getDomain(id: string): Promise<Domain | null> {
    const p = tryCurrentPrincipal();
    if (!p) return null;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, user_id, registrar, name, external_id, registrar_account_id, status,
                expires_at, auto_renew, nameservers, metadata, created_at, updated_at
           from ${this.schema}.domains
          where id = $1 and user_id = $2`,
        [id, p.id],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row ? this.rowToDomain(row) : null;
    });
  }

  async insertDomain(fields: {
    registrar: string;
    name: string;
    externalId?: string;
    registrarAccountId?: string;
    expiresAt?: Date;
    autoRenew?: boolean;
    nameservers?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Domain> {
    const p = tryCurrentPrincipal();
    if (!p) throw new Error('no principal');
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.domains
            (user_id, registrar, name, external_id, registrar_account_id, expires_at, auto_renew, nameservers, metadata)
         values ($1, $2, lower($3), $4, $5, $6, $7, $8, $9)
         returning id, user_id, registrar, name, external_id, registrar_account_id, status,
                   expires_at, auto_renew, nameservers, metadata, created_at, updated_at`,
        [
          p.id,
          fields.registrar,
          fields.name,
          fields.externalId ?? null,
          fields.registrarAccountId ?? null,
          fields.expiresAt ?? null,
          fields.autoRenew ?? null,
          fields.nameservers ? JSON.stringify(fields.nameservers) : null,
          JSON.stringify(fields.metadata ?? {}),
        ],
      );
      return this.rowToDomain(r.rows[0] as Record<string, unknown>);
    });
  }

  async upsertDomain(fields: {
    registrar: string;
    name: string;
    externalId?: string;
    registrarAccountId?: string;
    expiresAt?: Date;
    autoRenew?: boolean;
    nameservers?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Domain> {
    const p = tryCurrentPrincipal();
    if (!p) throw new Error('no principal');
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.domains
            (user_id, registrar, name, external_id, registrar_account_id, expires_at, auto_renew, nameservers, metadata, status)
         values ($1, $2, lower($3), $4, $5, $6, $7, $8, $9, 'active')
         on conflict (user_id, lower(name)) where status = 'active'
         do update set
           registrar = excluded.registrar,
           external_id = coalesce(excluded.external_id, ${this.schema}.domains.external_id),
           registrar_account_id = coalesce(excluded.registrar_account_id, ${this.schema}.domains.registrar_account_id),
           expires_at = coalesce(excluded.expires_at, ${this.schema}.domains.expires_at),
           auto_renew = coalesce(excluded.auto_renew, ${this.schema}.domains.auto_renew),
           nameservers = coalesce(excluded.nameservers, ${this.schema}.domains.nameservers),
           metadata = ${this.schema}.domains.metadata || excluded.metadata,
           updated_at = now()
         returning id, user_id, registrar, name, external_id, registrar_account_id, status,
                   expires_at, auto_renew, nameservers, metadata, created_at, updated_at`,
        [
          p.id,
          fields.registrar,
          fields.name,
          fields.externalId ?? null,
          fields.registrarAccountId ?? null,
          fields.expiresAt ?? null,
          fields.autoRenew ?? null,
          fields.nameservers ? JSON.stringify(fields.nameservers) : null,
          JSON.stringify(fields.metadata ?? {}),
        ],
      );
      return this.rowToDomain(r.rows[0] as Record<string, unknown>);
    });
  }

  async updateDomain(
    id: string,
    fields: {
      expiresAt?: Date | null;
      autoRenew?: boolean | null;
      status?: string;
    },
  ): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      const updates: string[] = [];
      const params: unknown[] = [id, p.id];
      let paramIndex = 3;
      if (fields.expiresAt !== undefined) {
        updates.push(`expires_at = $${paramIndex}`);
        params.push(fields.expiresAt);
        paramIndex++;
      }
      if (fields.autoRenew !== undefined) {
        updates.push(`auto_renew = $${paramIndex}`);
        params.push(fields.autoRenew);
        paramIndex++;
      }
      if (fields.status !== undefined) {
        updates.push(`status = $${paramIndex}`);
        params.push(fields.status);
        paramIndex++;
      }
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      await q(
        `update ${this.schema}.domains
          set ${updates.join(', ')}
         where id = $1 and user_id = $2`,
        params,
      );
    });
  }

  async archiveDomain(id: string): Promise<void> {
    await this.updateDomain(id, { status: 'archived' });
  }

  private rowToDomain(row: Record<string, unknown>): Domain {
    return {
      id: String(row['id']),
      user_id: String(row['user_id']),
      registrar: String(row['registrar']),
      name: String(row['name']),
      external_id: (row['external_id'] as string | null) ?? null,
      registrar_account_id: (row['registrar_account_id'] as string | null) ?? null,
      status: String(row['status']),
      expires_at: (row['expires_at'] as Date | null) ?? null,
      auto_renew: (row['auto_renew'] as boolean | null) ?? null,
      nameservers: (row['nameservers'] as string[] | null) ?? null,
      metadata: (row['metadata'] as Record<string, unknown>) ?? {},
      created_at: row['created_at'] as Date,
      updated_at: row['updated_at'] as Date,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
