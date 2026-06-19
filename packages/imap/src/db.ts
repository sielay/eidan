// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

// One named mail account in the per-user registry. The non-secret connection fields (hosts, ports,
// usernames, the SMTP From) live here in plain columns; only the IMAP/SMTP passwords are sealed in
// the vault, referenced by `imap_pass_key` / `smtp_pass_key`. Modeled on iCal's CalendarRow.
export interface AccountRow {
  id: string;
  name: string;
  slug: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass_key: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass_key: string;
  smtp_from: string;
}

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

// Owns plugin_imap.* — the per-user mail-account registry. No password ever lands here; each is
// sealed in the vault (eidan.secrets_vault) under the account's pass key. This table holds only the
// name and the non-secret connection coordinates (host/port/user, SMTP From) plus those key refs.
// Principal-stamped like core's storage/memory plugins so RLS stays consistent if it's ever added.
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
  // migration step (the tracked migrations/ SQL mirrors this for the migrate runner).
  async ensureSchema(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('create schema if not exists plugin_imap');
      await c.query(
        `create table if not exists plugin_imap.accounts (
           id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id       uuid NOT NULL,
           name          text NOT NULL,
           slug          text NOT NULL,
           imap_host     text NOT NULL,
           imap_port     integer NOT NULL DEFAULT 993,
           imap_user     text NOT NULL,
           imap_pass_key text NOT NULL,
           smtp_host     text NOT NULL DEFAULT '',
           smtp_port     integer NOT NULL DEFAULT 587,
           smtp_user     text NOT NULL DEFAULT '',
           smtp_pass_key text NOT NULL DEFAULT '',
           smtp_from     text NOT NULL DEFAULT '',
           status        text NOT NULL DEFAULT 'active',
           created_at    timestamptz NOT NULL DEFAULT now(),
           updated_at    timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await c.query(
        `create unique index if not exists uq_imap_user_slug
           on plugin_imap.accounts (user_id, slug) where status = 'active'`,
      );
      await c.query('create index if not exists idx_imap_user on plugin_imap.accounts (user_id)');
    } finally {
      c.release();
    }
  }

  // The current user's active mail accounts (resolved from the ambient matbot Principal).
  async listAccounts(): Promise<AccountRow[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, name, slug, imap_host, imap_port, imap_user, imap_pass_key,
                smtp_host, smtp_port, smtp_user, smtp_pass_key, smtp_from
           from plugin_imap.accounts
          where user_id = $1 and status = 'active'
          order by created_at`,
        [p.id],
      );
      return r.rows as AccountRow[];
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
