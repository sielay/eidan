// SPDX-License-Identifier: AGPL-3.0-or-later
import { currentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';

// A promoted procedure is a knowledge-graph node: a row in eidan.knowledge under skill='procedure'
// (body = the JS source). It is therefore recallable like any other knowledge and versioned by the
// same (user_id,skill,title) upsert. Reads carry an explicit user_id predicate so scoping holds
// even on a role where RLS isn't FORCEd.
const SKILL = 'procedure';

export interface ProcedureSummary {
  name: string;
  preview: string;
}

export class ProcedureStore {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async save(name: string, source: string): Promise<string> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into eidan.knowledge (user_id,skill,title,body)
         values ($1,$2,$3,$4)
         on conflict (user_id,skill,title) where deleted_at is null
           do update set body=excluded.body, updated_at=now()
         returning id`,
        [currentPrincipal().id, SKILL, name, source],
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async get(name: string): Promise<string | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select body from eidan.knowledge
          where user_id=$1 and skill=$2 and title=$3 and deleted_at is null
          limit 1`,
        [currentPrincipal().id, SKILL, name],
      );
      const row = r.rows[0] as { body: string } | undefined;
      return row ? row.body : null;
    });
  }

  async list(): Promise<ProcedureSummary[]> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select title, left(body, 160) as preview from eidan.knowledge
          where user_id=$1 and skill=$2 and deleted_at is null
          order by updated_at desc limit 100`,
        [currentPrincipal().id, SKILL],
      );
      return (r.rows as Array<{ title: string; preview: string }>).map((row) => ({ name: row.title, preview: row.preview }));
    });
  }
}
