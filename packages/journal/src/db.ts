// SPDX-License-Identifier: AGPL-3.0-or-later
// Journal data layer. Owner-scoped structured note log in its own schema (plugin_journal), stamped
// with the ambient principal for RLS, idempotent ensureSchema (no migrate runner) — same shape as
// packages/boards. Two tables: entries (the log) + settings (one editable direction prompt per user).
// Code-job enqueue writes eidan.jobs directly (a raw insert with an explicit user_id, exactly like
// the `delegate` tool) — that path is not owner-tx-scoped, so it runs on the bare pool.
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { EntryType, JournalEntry, JournalSettings } from './types.js';
import { DEFAULT_DIRECTION_PROMPT } from './types.js';

type Q = (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;

export interface CaptureInput {
  project: string | null;
  entry_type: EntryType;
  summary: string;
  body: string | null;
  source: string | null;
  target_repo: string | null;
}

export interface QueryFilter {
  project?: string | null;
  entry_type?: EntryType | null;
  since?: string | null; // ISO timestamp or Postgres interval-friendly text
  limit?: number;
}

export class JournalDb {
  private pool: pg.Pool;
  readonly schema = 'plugin_journal';

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url });
  }

  async ensureSchema(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`create schema if not exists ${this.schema}`);
      await c.query(
        `create table if not exists ${this.schema}.entries (
           id uuid primary key default gen_random_uuid(),
           user_id uuid not null,
           project text,
           entry_type text not null default 'devlog',
           summary text not null,
           body text,
           source text,
           target_repo text,
           metadata jsonb not null default '{}'::jsonb,
           job_id uuid,
           created_at timestamptz not null default now(),
           updated_at timestamptz not null default now(),
           deleted_at timestamptz
         )`,
      );
      await c.query(
        `create table if not exists ${this.schema}.settings (
           user_id uuid primary key,
           direction_prompt text not null,
           updated_at timestamptz not null default now()
         )`,
      );
      await c.query(
        `create index if not exists idx_${this.schema}_entries_user on ${this.schema}.entries (user_id, created_at desc) where deleted_at is null`,
      );
      await c.query(
        `create index if not exists idx_${this.schema}_entries_project on ${this.schema}.entries (user_id, project) where deleted_at is null`,
      );
    } finally {
      c.release();
    }
  }

  private async tx<R>(fn: (q: Q) => Promise<R>): Promise<R> {
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

  private uid(): string | null {
    return tryCurrentPrincipal()?.id ?? null;
  }

  // ── entries ────────────────────────────────────────────────────────────────
  async insertEntry(input: CaptureInput): Promise<JournalEntry | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.entries (user_id, project, entry_type, summary, body, source, target_repo)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [uid, input.project, input.entry_type, input.summary, input.body, input.source, input.target_repo],
      );
      return (r.rows[0] as JournalEntry | undefined) ?? null;
    });
  }

  async stampJob(entryId: string, jobId: string): Promise<void> {
    const uid = this.uid();
    if (!uid) return;
    await this.tx(async (q) => {
      await q(
        `update ${this.schema}.entries set job_id = $3, updated_at = now() where id = $1 and user_id = $2`,
        [entryId, uid, jobId],
      );
    });
  }

  async queryEntries(f: QueryFilter): Promise<JournalEntry[]> {
    const uid = this.uid();
    if (!uid) return [];
    const conds = ['user_id = $1', 'deleted_at is null'];
    const vals: unknown[] = [uid];
    if (f.project) { vals.push(f.project); conds.push(`project = $${vals.length}`); }
    if (f.entry_type) { vals.push(f.entry_type); conds.push(`entry_type = $${vals.length}`); }
    if (f.since) { vals.push(f.since); conds.push(`created_at >= $${vals.length}::timestamptz`); }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    vals.push(limit);
    return this.tx(async (q) => {
      const r = await q(
        `select * from ${this.schema}.entries where ${conds.join(' and ')} order by created_at desc limit $${vals.length}`,
        vals,
      );
      return r.rows as JournalEntry[];
    });
  }

  // ── settings (the direction prompt) ──────────────────────────────────────────
  async getDirection(): Promise<string> {
    const uid = this.uid();
    if (!uid) return DEFAULT_DIRECTION_PROMPT;
    return this.tx(async (q) => {
      const r = await q(`select direction_prompt from ${this.schema}.settings where user_id = $1`, [uid]);
      const row = r.rows[0] as { direction_prompt?: string } | undefined;
      return row?.direction_prompt ?? DEFAULT_DIRECTION_PROMPT;
    });
  }

  async setDirection(prompt: string): Promise<JournalSettings | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.settings (user_id, direction_prompt, updated_at)
         values ($1, $2, now())
         on conflict (user_id) do update set direction_prompt = excluded.direction_prompt, updated_at = now()
         returning *`,
        [uid, prompt],
      );
      return (r.rows[0] as JournalSettings | undefined) ?? null;
    });
  }

  // ── code-job enqueue (writes eidan.jobs, like the `delegate` tool) ────────────
  // Raw pool insert with an explicit user_id (null for non-uuid principals, id kept in payload).
  async enqueueCodeJob(userId: string | null, requestedBy: string | null, goal: string, payload: Record<string, unknown>): Promise<string | null> {
    const r = await this.pool.query(
      `insert into eidan.jobs (kind, goal, payload, user_id, status, surface, agent)
       values ('code', $1, $2::jsonb, $3::uuid, 'queued', 'journal', null) returning id`,
      [goal, JSON.stringify({ ...payload, ...(requestedBy ? { requested_by: requestedBy } : {}) }), userId],
    );
    return (r.rows[0] as { id?: string } | undefined)?.id ?? null;
  }
}
