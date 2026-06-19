// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export interface CalendarRow {
  id: string;
  name: string;
  slug: string;
  context: string;
  vault_key: string;
}

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

// Owns plugin_ical.* — the per-user calendar registry. The .ics URL itself never lands here; it's
// sealed in the vault (eidan.secrets_vault) under `vault_key`. This table holds only the name, the
// agent-facing context prompt, and that key. Principal-stamped like core's storage/memory plugins so
// RLS stays consistent if it's ever added to plugin schemas.
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
      await c.query('create schema if not exists plugin_ical');
      await c.query(
        `create table if not exists plugin_ical.calendars (
           id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           user_id    uuid NOT NULL,
           name       text NOT NULL,
           slug       text NOT NULL,
           context    text NOT NULL DEFAULT '',
           vault_key  text NOT NULL,
           status     text NOT NULL DEFAULT 'active',
           created_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await c.query(
        `create unique index if not exists uq_ical_user_slug
           on plugin_ical.calendars (user_id, slug) where status = 'active'`,
      );
      await c.query('create index if not exists idx_ical_user on plugin_ical.calendars (user_id)');
      // Per-user settings: the across-calendars "routine" note (day rhythm / constraints, ADHD
      // support) and the operator's IANA timezone (so the agent reasons about times in their zone,
      // not the engine's UTC). `add column if not exists` keeps it idempotent across upgrades.
      await c.query(
        `create table if not exists plugin_ical.settings (
           user_id    uuid PRIMARY KEY,
           routine    text NOT NULL DEFAULT '',
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await c.query(`alter table plugin_ical.settings add column if not exists timezone text NOT NULL DEFAULT ''`);
    } finally {
      c.release();
    }
  }

  // The current user's routine note + timezone (empty strings when unset).
  async getSettings(): Promise<{ routine: string; timezone: string }> {
    const p = tryCurrentPrincipal();
    if (!p) return { routine: '', timezone: '' };
    return this.withPrincipalTx(async (q) => {
      const r = await q('select routine, timezone from plugin_ical.settings where user_id = $1', [p.id]);
      const row = r.rows[0] as { routine?: string; timezone?: string } | undefined;
      return { routine: row?.routine ?? '', timezone: row?.timezone ?? '' };
    });
  }

  // The routine note alone (the calendar tools surface it alongside events).
  async getRoutine(): Promise<string> {
    return (await this.getSettings()).routine;
  }

  // The current user's active calendars (resolved from the ambient matbot Principal).
  async listCalendars(): Promise<CalendarRow[]> {
    const p = tryCurrentPrincipal();
    if (!p) return [];
    return this.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, name, slug, context, vault_key
           from plugin_ical.calendars
          where user_id = $1 and status = 'active'
          order by created_at`,
        [p.id],
      );
      return r.rows as CalendarRow[];
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
