// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

export class CrmDb {
  readonly pool: pg.Pool;
  readonly schema = 'plugin_crm';

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async ensureSchema(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`create schema if not exists ${this.schema}`);

      await c.query(`
        create table if not exists ${this.schema}.contacts (
          id          uuid        primary key default gen_random_uuid(),
          user_id     uuid        not null,
          venture_id  uuid        not null,
          name        text        not null,
          email       text,
          phone       text,
          company     text,
          role        text,
          metadata    jsonb       not null default '{}'::jsonb,
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now(),
          deleted_at  timestamptz
        )
      `);

      await c.query(`
        create index if not exists idx_crm_contacts_user on ${this.schema}.contacts (user_id) where deleted_at is null
      `);
      await c.query(`
        create index if not exists idx_crm_contacts_venture on ${this.schema}.contacts (venture_id) where deleted_at is null
      `);

      await c.query(`
        create table if not exists ${this.schema}.deals (
          id              uuid        primary key default gen_random_uuid(),
          user_id         uuid        not null,
          venture_id      uuid        not null,
          contact_id      uuid        references ${this.schema}.contacts(id) on delete set null,
          name            text        not null,
          value_cents     bigint      not null default 0,
          currency        text        not null default 'GBP',
          stage           text        not null,
          position        integer     not null default 0,
          expected_close  date,
          metadata        jsonb       not null default '{}'::jsonb,
          created_at      timestamptz not null default now(),
          updated_at      timestamptz not null default now(),
          deleted_at      timestamptz
        )
      `);

      await c.query(`
        create index if not exists idx_crm_deals_user on ${this.schema}.deals (user_id) where deleted_at is null
      `);
      await c.query(`
        create index if not exists idx_crm_deals_venture on ${this.schema}.deals (venture_id) where deleted_at is null
      `);
      await c.query(`
        create index if not exists idx_crm_deals_stage on ${this.schema}.deals (venture_id, stage) where deleted_at is null
      `);

      await c.query(`
        create table if not exists ${this.schema}.activities (
          id          uuid        primary key default gen_random_uuid(),
          user_id     uuid        not null,
          venture_id  uuid        not null,
          deal_id     uuid        references ${this.schema}.deals(id) on delete set null,
          contact_id  uuid        references ${this.schema}.contacts(id) on delete set null,
          kind        text        not null,
          body        text,
          metadata    jsonb       not null default '{}'::jsonb,
          occurred_at timestamptz not null default now(),
          created_at  timestamptz not null default now(),
          constraint crm_activities_kind_chk check (kind in ('call', 'email', 'note', 'meeting', 'stage_change'))
        )
      `);

      await c.query(`
        create index if not exists idx_crm_activities_deal on ${this.schema}.activities (deal_id)
      `);
      await c.query(`
        create index if not exists idx_crm_activities_contact on ${this.schema}.activities (contact_id)
      `);
      await c.query(`
        create index if not exists idx_crm_activities_user on ${this.schema}.activities (user_id, venture_id)
      `);
      await c.query(`
        create index if not exists idx_crm_activities_occurred on ${this.schema}.activities (user_id, occurred_at desc)
      `);
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
