// SPDX-License-Identifier: AGPL-3.0-or-later
// Boards data layer. A bundle-agnostic kanban substrate in its own schema (plugin_boards), owner-
// scoped via the ambient principal (RLS stamp), idempotent ensureSchema (no migrate runner). Four
// tables: boards → cards → (card_refs, card_events). A board optionally binds to a context via
// scope_kind/scope_id (e.g. 'venture'/<id>, later 'charlotte'/<id>) or is standalone (null scope).
import pg from 'pg';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

type Q = (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;

export interface Board { id: string; user_id: string; name: string; prompt: string | null; scope_kind: string | null; scope_id: string | null; position: number; status: string; created_at: Date; updated_at: Date }
export interface Card { id: string; board_id: string; user_id: string; title: string; body: string | null; status: string; position: number; metadata: Record<string, unknown>; due_date: string | null; created_at: Date; updated_at: Date }
export interface CardRef { id: string; card_id: string; user_id: string; ref_kind: string; ref_id: string | null; ref_label: string | null; metadata: Record<string, unknown>; created_at: Date }
export interface CardEvent { id: string; card_id: string; user_id: string; kind: string; body: string | null; author_kind: string; author_id: string | null; author_label: string | null; metadata: Record<string, unknown>; created_at: Date }

export const CARD_STATUSES = ['open', 'doing', 'done', 'archived'];
export const EVENT_KINDS = ['comment', 'status', 'ref', 'system', 'note'];

export class BoardsDb {
  private pool: pg.Pool;
  readonly schema = 'plugin_boards';

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url });
  }

  async ensureSchema(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(`create schema if not exists ${this.schema}`);
      await c.query(
        `create table if not exists ${this.schema}.boards (
           id uuid primary key default gen_random_uuid(),
           user_id uuid not null,
           name text not null,
           scope_kind text,
           scope_id text,
           position int not null default 0,
           status text not null default 'active' check (status in ('active','archived')),
           created_at timestamptz not null default now(),
           updated_at timestamptz not null default now()
         )`,
      );
      await c.query(
        `create table if not exists ${this.schema}.cards (
           id uuid primary key default gen_random_uuid(),
           board_id uuid not null references ${this.schema}.boards(id) on delete cascade,
           user_id uuid not null,
           title text not null,
           body text,
           status text not null default 'open' check (status in ('open','doing','done','archived')),
           position int not null default 0,
           metadata jsonb not null default '{}'::jsonb,
           due_date date,
           created_at timestamptz not null default now(),
           updated_at timestamptz not null default now()
         )`,
      );
      await c.query(`alter table ${this.schema}.cards add column if not exists due_date date default null`);
      await c.query(
        `create table if not exists ${this.schema}.card_refs (
           id uuid primary key default gen_random_uuid(),
           card_id uuid not null references ${this.schema}.cards(id) on delete cascade,
           user_id uuid not null,
           ref_kind text not null,
           ref_id text,
           ref_label text,
           metadata jsonb not null default '{}'::jsonb,
           created_at timestamptz not null default now()
         )`,
      );
      await c.query(
        `create table if not exists ${this.schema}.card_events (
           id uuid primary key default gen_random_uuid(),
           card_id uuid not null references ${this.schema}.cards(id) on delete cascade,
           user_id uuid not null,
           kind text not null,
           body text,
           author_kind text not null default 'user',
           author_id text,
           author_label text,
           metadata jsonb not null default '{}'::jsonb,
           created_at timestamptz not null default now()
         )`,
      );
      // Author columns (idempotent — comments carry who wrote them: a person or an agent).
      await c.query(`alter table ${this.schema}.card_events add column if not exists author_kind text not null default 'user'`);
      await c.query(`alter table ${this.schema}.card_events add column if not exists author_id text`);
      await c.query(`alter table ${this.schema}.card_events add column if not exists author_label text`);
      // A board prompt — standing context explaining what the board is for, given to agents working it.
      await c.query(`alter table ${this.schema}.boards add column if not exists prompt text`);
      await c.query(`create index if not exists idx_${this.schema}_boards_scope on ${this.schema}.boards (user_id, scope_kind, scope_id)`);
      await c.query(`create index if not exists idx_${this.schema}_cards_board on ${this.schema}.cards (board_id)`);
      await c.query(`create index if not exists idx_${this.schema}_refs_card on ${this.schema}.card_refs (card_id)`);
      await c.query(`create index if not exists idx_${this.schema}_events_card on ${this.schema}.card_events (card_id, created_at)`);
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

  // Resolve the firing agent (id + name) from the conversation, so a card comment is attributed to the
  // actual agent (Eidan / a custom agent / Sage) and gets that agent's avatar (seeded by id, as the
  // Agents list does). Returns null for the default assistant / no agent.
  async resolveAgent(conversationId: string): Promise<{ id: string; name: string } | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) return null;
    try {
      const r = await this.pool.query(
        `select a.id, a.name from eidan.conversations c join eidan.agents a on a.id = c.agent_id where c.id = $1`,
        [conversationId],
      );
      const row = r.rows[0] as { id: string; name: string } | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  // ── boards ───────────────────────────────────────────────────────────────
  async listBoards(scopeKind: string | null, scopeId: string | null): Promise<Board[]> {
    const uid = this.uid();
    if (!uid) return [];
    return this.tx(async (q) => {
      const r = await q(
        `select * from ${this.schema}.boards
          where user_id = $1 and status = 'active'
            and ($2::text is null or scope_kind is not distinct from $2)
            and ($3::text is null or scope_id is not distinct from $3)
          order by position, created_at`,
        [uid, scopeKind, scopeId],
      );
      return r.rows as Board[];
    });
  }

  async createBoard(name: string, scopeKind: string | null, scopeId: string | null): Promise<Board | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.boards (user_id, name, scope_kind, scope_id, position)
         values ($1, $2, $3, $4,
           coalesce((select max(position) + 1 from ${this.schema}.boards
                      where user_id = $1 and status = 'active'
                        and scope_kind is not distinct from $3 and scope_id is not distinct from $4), 0))
         returning *`,
        [uid, name, scopeKind, scopeId],
      );
      return (r.rows[0] as Board | undefined) ?? null;
    });
  }

  async renameBoard(id: string, name: string): Promise<Board | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      const r = await q(
        `update ${this.schema}.boards set name = $3, updated_at = now()
          where id = $1 and user_id = $2 and status = 'active' returning *`,
        [id, uid, name],
      );
      return (r.rows[0] as Board | undefined) ?? null;
    });
  }

  async archiveBoard(id: string): Promise<boolean> {
    const uid = this.uid();
    if (!uid) return false;
    return this.tx(async (q) => {
      const r = await q(
        `update ${this.schema}.boards set status = 'archived', updated_at = now()
          where id = $1 and user_id = $2 and status = 'active'`,
        [id, uid],
      );
      if (!r.rowCount) return false;
      await q(`update ${this.schema}.cards set status = 'archived', updated_at = now() where board_id = $1 and user_id = $2 and status <> 'archived'`, [id, uid]);
      return true;
    });
  }

  async setBoardPrompt(id: string, prompt: string | null): Promise<Board | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      const r = await q(
        `update ${this.schema}.boards set prompt = $3, updated_at = now()
          where id = $1 and user_id = $2 and status = 'active' returning *`,
        [id, uid, prompt && prompt.trim() ? prompt : null],
      );
      return (r.rows[0] as Board | undefined) ?? null;
    });
  }

  // ── cards ────────────────────────────────────────────────────────────────
  async listCards(boardId: string): Promise<Card[]> {
    const uid = this.uid();
    if (!uid) return [];
    return this.tx(async (q) => {
      const r = await q(
        `select * from ${this.schema}.cards
          where user_id = $1 and board_id = $2 and status <> 'archived'
          order by due_date is null, due_date asc, position, created_at desc`,
        [uid, boardId],
      );
      return r.rows as Card[];
    });
  }

  async createCard(boardId: string, title: string, body: string | null, dueDate: string | null = null): Promise<Card | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      // INSERT…SELECT guards board ownership in one statement.
      const r = await q(
        `insert into ${this.schema}.cards (board_id, user_id, title, body, due_date)
         select b.id, $1, $3, $4, $5 from ${this.schema}.boards b
          where b.id = $2 and b.user_id = $1 and b.status = 'active'
         returning *`,
        [uid, boardId, title, body, dueDate],
      );
      return (r.rows[0] as Card | undefined) ?? null;
    });
  }

  async updateCard(id: string, patch: { title?: string; body?: string | null; status?: string; due_date?: string | null }): Promise<Card | null> {
    const uid = this.uid();
    if (!uid) return null;
    const sets: string[] = [];
    const vals: unknown[] = [id, uid];
    if (patch.title !== undefined) { vals.push(patch.title); sets.push(`title = $${vals.length}`); }
    if (patch.body !== undefined) { vals.push(patch.body); sets.push(`body = $${vals.length}`); }
    if (patch.status !== undefined) { vals.push(patch.status); sets.push(`status = $${vals.length}`); }
    if (patch.due_date !== undefined) { vals.push(patch.due_date); sets.push(`due_date = $${vals.length}`); }
    if (!sets.length) return null;
    return this.tx(async (q) => {
      const r = await q(
        `update ${this.schema}.cards set ${sets.join(', ')}, updated_at = now()
          where id = $1 and user_id = $2 returning *`,
        vals,
      );
      const card = (r.rows[0] as Card | undefined) ?? null;
      if (card && patch.status !== undefined) {
        await q(`insert into ${this.schema}.card_events (card_id, user_id, kind, body) values ($1, $2, 'status', $3)`, [id, uid, patch.status]);
      }
      return card;
    });
  }

  // ── refs ─────────────────────────────────────────────────────────────────
  async listRefs(cardId: string): Promise<CardRef[]> {
    const uid = this.uid();
    if (!uid) return [];
    return this.tx(async (q) => {
      const r = await q(`select * from ${this.schema}.card_refs where user_id = $1 and card_id = $2 order by created_at`, [uid, cardId]);
      return r.rows as CardRef[];
    });
  }

  async addRef(cardId: string, refKind: string, refId: string | null, refLabel: string | null): Promise<CardRef | null> {
    const uid = this.uid();
    if (!uid) return null;
    return this.tx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.card_refs (card_id, user_id, ref_kind, ref_id, ref_label)
         select c.id, $1, $3, $4, $5 from ${this.schema}.cards c
          where c.id = $2 and c.user_id = $1
         returning *`,
        [uid, cardId, refKind, refId, refLabel],
      );
      const ref = (r.rows[0] as CardRef | undefined) ?? null;
      if (ref) await q(`insert into ${this.schema}.card_events (card_id, user_id, kind, body) values ($1, $2, 'ref', $3)`, [cardId, uid, `linked ${refKind}${refLabel ? `: ${refLabel}` : ''}`]);
      return ref;
    });
  }

  async removeRef(refId: string): Promise<boolean> {
    const uid = this.uid();
    if (!uid) return false;
    return this.tx(async (q) => {
      const r = await q(`delete from ${this.schema}.card_refs where id = $1 and user_id = $2`, [refId, uid]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  // ── events / comments ──────────────────────────────────────────────────────
  async listEvents(cardId: string): Promise<CardEvent[]> {
    const uid = this.uid();
    if (!uid) return [];
    return this.tx(async (q) => {
      const r = await q(`select * from ${this.schema}.card_events where user_id = $1 and card_id = $2 order by created_at`, [uid, cardId]);
      return r.rows as CardEvent[];
    });
  }

  async addEvent(cardId: string, kind: string, body: string | null, author?: { kind: string; id: string | null; label: string | null }): Promise<CardEvent | null> {
    const uid = this.uid();
    if (!uid) return null;
    const aKind = author?.kind ?? 'user';
    return this.tx(async (q) => {
      const r = await q(
        `insert into ${this.schema}.card_events (card_id, user_id, kind, body, author_kind, author_id, author_label)
         select c.id, $1, $3, $4, $5, $6, $7 from ${this.schema}.cards c where c.id = $2 and c.user_id = $1
         returning *`,
        [uid, cardId, kind, body, aKind, author?.id ?? null, author?.label ?? null],
      );
      return (r.rows[0] as CardEvent | undefined) ?? null;
    });
  }
}
