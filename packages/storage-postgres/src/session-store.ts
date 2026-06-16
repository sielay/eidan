// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Store, Session, Message, MessageContent, CASResult, QueryResult, StoreQuery,
} from '@matatbread/matbot-plugin-api';
import { currentPrincipal } from '@matatbread/matbot-plugin-api';
import type { Db, Q } from './db.js';
import { type ConvRow, type MsgRow, rowToSession, rowToMessage } from './row-mappers.js';

// matbot keeps the whole Session (with messages[]) as one CAS'd document; eidan keeps messages
// as append-only rows. They reconcile because matbot Messages carry stable ids: `set(session)`
// upserts the conversation, then INSERTs only the messages whose id isn't already a row. That IS
// eidan's keen append-only invariant — existing rows are never rewritten or deleted by a set.
export class PgSessionStore implements Store<Session> {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async get(id: string): Promise<Session | null> {
    return this.db.withPrincipalTx((q) => this.read(q, id));
  }

  async set(id: string, value: Session): Promise<void> {
    await this.db.withPrincipalTx((q) => this.apply(q, id, value));
  }

  async cas(id: string, expected: string, next: Session): Promise<CASResult<Session>> {
    return this.db.withPrincipalTx<CASResult<Session>>(async (q) => {
      const cur = await q('select version from eidan.conversations where id=$1 and deleted_at is null', [id]);
      const row = cur.rows[0] as { version: string } | undefined;
      const curVer = row ? String(row.version) : null;
      if (curVer === null || curVer !== expected) {
        return { ok: false, current: await this.read(q, id) };
      }
      await this.apply(q, id, next);
      const doc = await this.read(q, id);
      if (!doc) throw new Error('session disappeared mid-CAS');
      return { ok: true, doc };
    });
  }

  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    return this.db.withPrincipalTx(async (q) => {
      if (expectedVersion !== undefined) {
        const cur = await q('select version from eidan.conversations where id=$1', [id]);
        const row = cur.rows[0] as { version: string } | undefined;
        if (!row || String(row.version) !== expectedVersion) return false;
      }
      const r = await q('update eidan.conversations set deleted_at=now() where id=$1 and deleted_at is null', [id]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  async query(qy: StoreQuery<Session>): Promise<QueryResult<Session>> {
    return this.db.withPrincipalTx(async (q) => {
      const rows = await q(
        'select id from eidan.conversations where deleted_at is null order by updated_at desc limit $1',
        [qy.limit ?? 50],
      );
      const items: QueryResult<Session>['items'] = [];
      for (const r of rows.rows) {
        const s = await this.read(q, r.id as string);
        if (s) items.push({ doc: s });
      }
      return { items, total: items.length };
    });
  }

  private async read(q: Q, id: string): Promise<Session | null> {
    const c = await q('select * from eidan.conversations where id=$1 and deleted_at is null', [id]);
    const conv = c.rows[0] as ConvRow | undefined;
    if (!conv) return null;
    const m = await q(
      'select * from eidan.messages where conversation_id=$1 and deleted_at is null order by seq asc',
      [id],
    );
    return rowToSession(conv, (m.rows as MsgRow[]).map(rowToMessage));
  }

  private async apply(q: Q, id: string, s: Session): Promise<void> {
    const owner = currentPrincipal().id;
    await q(
      `insert into eidan.conversations
         (id,user_id,title,status,persona,contexts,parent_conversation_id,origin_message_id,version,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,1,now(),now())
       on conflict (id) do update set
         title=excluded.title, status=excluded.status, persona=excluded.persona,
         contexts=excluded.contexts, version=eidan.conversations.version+1, updated_at=now()`,
      [id, owner, s.title ?? null, s.status, s.persona ?? null, JSON.stringify(s.contexts ?? []),
       s.parentSessionId ?? null, s.branchPointMessageId ?? null],
    );

    const existing = await q('select id from eidan.messages where conversation_id=$1', [id]);
    const have = new Set<string>(existing.rows.map((r) => r.id as string));
    for (const msg of s.messages) {
      if (have.has(msg.id)) continue; // append-only: never rewrite a persisted message
      const text = msg.content
        .filter((b): b is Extract<MessageContent, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text).join('\n');
      const toolCalls = msg.content.filter((b) => b.type === 'tool-call');
      const toolResults = msg.content.filter((b) => b.type === 'tool-result');
      await q(
        `insert into eidan.messages
           (id,user_id,conversation_id,role,content,content_blocks,tool_calls,tool_results,provider,trace_id,created_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,now())`,
        [msg.id, owner, id, msg.role, text || null, JSON.stringify(msg.content),
         JSON.stringify(toolCalls), JSON.stringify(toolResults), msg.providerName ?? null, msg.traceId || null],
      );
    }
  }
}

// Generic KV store for any non-sessions namespace a plugin opens (settings, schedules, …).
export class PgKvStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly db: Db;
  private readonly ns: string;
  constructor(db: Db, ns: string) { this.db = db; this.ns = ns; }

  async get(id: string): Promise<T | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q('select doc from eidan.kv where namespace=$1 and id=$2', [this.ns, id]);
      const row = r.rows[0] as { doc: T } | undefined;
      return row ? row.doc : null;
    });
  }

  async set(id: string, value: T): Promise<void> {
    await this.db.withPrincipalTx(async (q) => {
      await q(
        `insert into eidan.kv (namespace,id,version,doc) values ($1,$2,$3,$4::jsonb)
         on conflict (namespace,id) do update set version=excluded.version, doc=excluded.doc`,
        [this.ns, id, value.version, JSON.stringify(value)],
      );
    });
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    return this.db.withPrincipalTx<CASResult<T>>(async (q) => {
      const r = await q('select doc,version from eidan.kv where namespace=$1 and id=$2', [this.ns, id]);
      const row = r.rows[0] as { doc: T; version: string } | undefined;
      if (!row || String(row.version) !== expected) return { ok: false, current: row ? row.doc : null };
      await q('update eidan.kv set version=$3, doc=$4::jsonb where namespace=$1 and id=$2',
        [this.ns, id, next.version, JSON.stringify(next)]);
      return { ok: true, doc: next };
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q('delete from eidan.kv where namespace=$1 and id=$2', [this.ns, id]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  async query(): Promise<QueryResult<T>> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q('select doc from eidan.kv where namespace=$1', [this.ns]);
      return { items: r.rows.map((row) => ({ doc: row.doc as T })), total: r.rowCount ?? 0 };
    });
  }
}
