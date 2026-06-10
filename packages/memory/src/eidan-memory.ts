// SPDX-License-Identifier: AGPL-3.0-or-later
import { Db } from './db.js';
import { currentPrincipal } from '@matatbread/matbot-plugin-api';

export interface KnowledgeHit {
  id: string; skill: string; title: string; body: string; rank: number;
}

// The relational memory surface matbot's document Store can't express — registered on
// MatbotServices as `EidanMemory` and consumed by the remember/recall tools. Every read
// relies on RLS for tenant scoping (note: no user_id predicate in the SELECTs); isolation
// is the GUC the Db helper stamps from the ambient principal.
export class EidanMemory {
  constructor(private readonly db: Db) {}

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
      // Forgiving recall: OR the query's lexemes (plainto/websearch both AND them, so a single
      // off-term — "tea preference" vs a "...tea..." entry — would wrongly return nothing). We
      // match ANY term and let ts_rank order by how well each entry matches.
      const r = await q(
        `with q as (
           select nullif(replace(plainto_tsquery('english',$1)::text, ' & ', ' | '), '')::tsquery as tq
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
}
