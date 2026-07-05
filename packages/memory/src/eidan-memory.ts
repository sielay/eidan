// SPDX-License-Identifier: AGPL-3.0-or-later
import { Db } from './db.js';
import { currentPrincipal } from '@matatbread/matbot-plugin-api';

export interface KnowledgeHit {
  id: string; skill: string; title: string; body: string; rank: number;
}

export interface CatalogueEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  source_url?: string;
  date_captured: string;
  tags: { ventures?: string[]; goals?: string[]; issues?: string[]; personal?: string[]; topics?: string[] };
  key_concepts: string[];
  status: 'raw' | 'catalogued' | 'archived';
}

// The relational memory surface matbot's document Store can't express — registered on
// MatbotServices as `EidanMemory` and consumed by the remember/recall tools. Every read
// relies on RLS for tenant scoping (note: no user_id predicate in the SELECTs); isolation
// is the GUC the Db helper stamps from the ambient principal.
export class EidanMemory {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async remember(e: { skill: string; title: string; body: string; source?: string; sourceType?: string }): Promise<string> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into eidan.knowledge (user_id,skill,title,body,source,source_type)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (user_id,skill,title) where deleted_at is null
           do update set body=excluded.body, updated_at=now()
         returning id`,
        [currentPrincipal().id, e.skill, e.title, e.body, e.source ?? null, e.sourceType ?? null],
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async searchKnowledge(query: string, limit = 10): Promise<KnowledgeHit[]> {
    return this.db.withPrincipalTx(async (q) => {
      // Richer recall: websearch_to_tsquery natively supports quoted phrases, OR, and -term negation.
      const r = await q(
        `with q as (
           select nullif(websearch_to_tsquery('english', $1)::text, '')::tsquery as tq
         )
         select k.id, k.skill, k.title, k.body, ts_rank(k.body_tsv, q.tq) as rank
           from eidan.knowledge k, q
          where k.deleted_at is null
            and q.tq is not null
            and k.body_tsv @@ q.tq
          order by rank desc
          limit $2`,
        [query, limit],
      );
      return (r.rows as Array<{ id: string; skill: string; title: string; body: string; rank: number }>).map((row) => ({
        id: row.id, skill: row.skill, title: row.title, body: row.body, rank: Number(row.rank),
      }));
    });
  }

  async note(content: string, conversationId?: string): Promise<string> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        'insert into eidan.notes (user_id,conversation_id,content) values ($1,$2,$3) returning id',
        [currentPrincipal().id, conversationId ?? null, content],
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async listNotes(limit = 50): Promise<Array<{ id: string; content: string }>> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q('select id, content from eidan.notes where deleted_at is null order by created_at desc limit $1', [limit]);
      return (r.rows as Array<{ id: string; content: string }>).map((row) => ({ id: row.id, content: row.content }));
    });
  }

  async catalogueCapture(entry: {
    title: string;
    content: string;
    source: string;
    source_url?: string;
    tags?: { ventures?: string[]; goals?: string[]; issues?: string[]; personal?: string[]; topics?: string[] };
    key_concepts?: string[];
  }): Promise<string> {
    return this.db.withPrincipalTx(async (q) => {
      const tags = entry.tags ?? {};
      const keyConcepts = entry.key_concepts ?? [];
      const r = await q(
        `insert into eidan.knowledge_catalogue
         (user_id, title, content, source, source_url, tags, key_concepts, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'raw')
         returning id`,
        [currentPrincipal().id, entry.title, entry.content, entry.source, entry.source_url ?? null, JSON.stringify(tags), keyConcepts],
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async catalogueRecall(opts: {
    ventures?: string[];
    goals?: string[];
    issues?: string[];
    personal?: string[];
    topics?: string[];
    query?: string;
    limit?: number;
  }): Promise<CatalogueEntry[]> {
    return this.db.withPrincipalTx(async (q) => {
      const limit = Math.min(opts.limit ?? 5, 50);
      const params: unknown[] = [];
      const tagConditions: string[] = [];
      let paramIdx = 1;

      if (opts.ventures?.length) {
        tagConditions.push(`kc.tags->'ventures' ?| $${paramIdx}::text[]`);
        params.push(opts.ventures);
        paramIdx++;
      }
      if (opts.goals?.length) {
        tagConditions.push(`kc.tags->'goals' ?| $${paramIdx}::text[]`);
        params.push(opts.goals);
        paramIdx++;
      }
      if (opts.issues?.length) {
        tagConditions.push(`kc.tags->'issues' ?| $${paramIdx}::text[]`);
        params.push(opts.issues);
        paramIdx++;
      }
      if (opts.personal?.length) {
        tagConditions.push(`kc.tags->'personal' ?| $${paramIdx}::text[]`);
        params.push(opts.personal);
        paramIdx++;
      }
      if (opts.topics?.length) {
        tagConditions.push(`kc.tags->'topics' ?| $${paramIdx}::text[]`);
        params.push(opts.topics);
        paramIdx++;
      }

      let where = `kc.deleted_at is null and kc.status = 'catalogued'`;
      if (tagConditions.length) {
        where += ' and (' + tagConditions.join(' or ') + ')';
      }

      if (opts.query) {
        where += ` and to_tsvector('english', kc.title || ' ' || kc.content) @@ websearch_to_tsquery('english', $${paramIdx})`;
        params.push(opts.query);
        paramIdx++;
      }

      params.push(limit);
      const sql = `
        select id, title, content, source, source_url, date_captured, tags, key_concepts, status
        from eidan.knowledge_catalogue kc
        where ${where}
        order by date_captured desc
        limit $${paramIdx}
      `;

      const r = await q(sql, params);
      return (r.rows as CatalogueEntry[]);
    });
  }

  async catalogueList(opts?: { status?: string; limit?: number }): Promise<CatalogueEntry[]> {
    return this.db.withPrincipalTx(async (q) => {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const status = opts?.status ?? 'raw';
      const r = await q(
        `select id, title, content, source, source_url, date_captured, tags, key_concepts, status
         from eidan.knowledge_catalogue
         where deleted_at is null and status = $1
         order by date_captured desc
         limit $2`,
        [status, limit],
      );
      return (r.rows as CatalogueEntry[]);
    });
  }
}
