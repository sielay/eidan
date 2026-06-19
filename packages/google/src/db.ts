// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export interface AccountRow {
  id: string;
  name: string;
  slug: string;
  email: string;
  client_vault_key: string;
  refresh_vault_key: string;
  status: string;
}

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

// Owns plugin_google.* — the per-user Gmail account registry. No tokens land here: the OAuth
// client id/secret and the durable refresh token are sealed in the vault (eidan.secrets_vault) under
// `client_vault_key` / `refresh_vault_key`. This table holds only the display name, the connected
// email, and those keys. Principal-stamped like core's storage/memory plugins (and ical) so RLS stays
// consistent if it's ever added to plugin schemas.
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

  // Idempotent: the plugin creates its own schema on first boot, so a deploy needs no separate
  // migration step (mirrors ical, which has no separate migrations/ dir either).
  async ensureSchema(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('create schema if not exists plugin_google');
      await c.query(
        `create table if not exists plugin_google.accounts (
           id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id           uuid NOT NULL,
           name              text NOT NULL,
           slug              text NOT NULL,
           email             text NOT NULL DEFAULT '',
           client_vault_key  text NOT NULL,
           refresh_vault_key text NOT NULL,
           status            text NOT NULL DEFAULT 'active',
           created_at        timestamptz NOT NULL DEFAULT now(),
           updated_at        timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Reserve the slug across both live states: an in-flight connect (pending) holds the name so a
      // double-submit can't create a duplicate, and an active account keeps it. Archived rows are free
      // to repeat (reconnecting a previously-removed account reuses the name).
      await c.query(
        `create unique index if not exists uq_google_user_slug
           on plugin_google.accounts (user_id, slug) where status in ('active', 'pending')`,
      );
      await c.query('create index if not exists idx_google_user on plugin_google.accounts (user_id)');
    } finally {
      c.release();
    }
  }

  // The current user's active Gmail accounts (resolved from the ambient matbot Principal).
  async listAccounts(): Promise<AccountRow[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, name, slug, email, client_vault_key, refresh_vault_key, status
           from plugin_google.accounts
          where user_id = $1 and status = 'active'
          order by created_at`,
        [p.id],
      );
      return r.rows as AccountRow[];
    });
  }

  // Owner-scoped lookup by id (used by the server-side OAuth reconnect server). Returns the row only
  // when it belongs to the ambient principal — null otherwise (missing, or another user's account).
  async getAccountById(id: string): Promise<AccountRow | null> {
    const p = tryCurrentPrincipal();
    if (!p) return null;
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, name, slug, email, client_vault_key, refresh_vault_key, status
           from plugin_google.accounts
          where id = $1 and user_id = $2`,
        [id, p.id],
      );
      return (r.rows[0] as AccountRow | undefined) ?? null;
    });
  }

  // Mark an in-flight reconnect: the consent URL has been issued, awaiting the callback. Owner-scoped.
  async setPending(id: string): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(
        `update plugin_google.accounts
            set status = 'pending', updated_at = now()
          where id = $1 and user_id = $2`,
        [id, p.id],
      );
    });
  }

  // Finalise a (re)connect: refresh token sealed, mailbox identified. Owner-scoped.
  async setActive(id: string, email: string): Promise<void> {
    const p = tryCurrentPrincipal();
    if (!p) return;
    await this.withPrincipalTx(async (q) => {
      await q(
        `update plugin_google.accounts
            set status = 'active', email = $3, updated_at = now()
          where id = $1 and user_id = $2`,
        [id, p.id, email],
      );
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
