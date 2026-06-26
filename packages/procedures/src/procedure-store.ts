// SPDX-License-Identifier: AGPL-3.0-or-later
import { currentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';

const SKILL = 'procedure';

export interface ProcedureSummary {
  name: string;
  preview: string;
}

export interface ProcedureDetail {
  id: string;
  name: string;
  source: string;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  schedule?: string;
  history?: ExecutionResult[];
}

export interface ExecutionResult {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result: unknown;
  error: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
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

  async getDetail(name: string): Promise<ProcedureDetail | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, title, body, created_at, updated_at
          from eidan.knowledge
          where user_id=$1 and skill=$2 and title=$3 and deleted_at is null
          limit 1`,
        [currentPrincipal().id, SKILL, name],
      );
      const row = r.rows[0] as { id: string; title: string; body: string; created_at: string; updated_at: string } | undefined;
      if (!row) return null;

      const execR = await q(
        `select started_at from eidan.procedure_executions
          where user_id=$1 and procedure_id=$2 and status='completed'
          order by created_at desc limit 1`,
        [currentPrincipal().id, row.id],
      );
      const lastExec = execR.rows[0] as { started_at: string } | undefined;

      return {
        id: row.id,
        name: row.title,
        source: row.body,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_run_at: lastExec?.started_at ?? null,
      };
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

  async delete(name: string): Promise<boolean> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `update eidan.knowledge set deleted_at=now()
          where user_id=$1 and skill=$2 and title=$3 and deleted_at is null`,
        [currentPrincipal().id, SKILL, name],
      );
      return r.rowCount > 0;
    });
  }

  async recordExecution(procedureName: string, status: 'queued' | 'running' | 'completed' | 'failed', result?: unknown, error?: string, durationMs?: number): Promise<string> {
    return this.db.withPrincipalTx(async (q) => {
      const procR = await q(
        `select id from eidan.knowledge where user_id=$1 and skill=$2 and title=$3 and deleted_at is null`,
        [currentPrincipal().id, SKILL, procedureName],
      );
      const procId = (procR.rows[0] as { id: string } | undefined)?.id;

      const r = await q(
        `insert into eidan.procedure_executions (user_id, procedure_id, procedure_name, status, result, error, duration_ms, finished_at)
         values ($1, $2, $3, $4, $5, $6, $7, case when $4 != 'queued' and $4 != 'running' then now() else null end)
         returning id`,
        [currentPrincipal().id, procId, procedureName, status, result ? JSON.stringify(result) : null, error, durationMs],
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async getExecutionHistory(procedureName: string, limit: number = 10): Promise<ExecutionResult[]> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, status, result, error, duration_ms, started_at, finished_at
          from eidan.procedure_executions
          where user_id=$1 and procedure_name=$2
          order by created_at desc limit $3`,
        [currentPrincipal().id, procedureName, limit],
      );
      return (r.rows as Array<{ id: string; status: string; result: string | null; error: string | null; duration_ms: number | null; started_at: string; finished_at: string | null }>).map((row) => ({
        id: row.id,
        status: row.status as 'queued' | 'running' | 'completed' | 'failed',
        result: row.result ? JSON.parse(row.result) : null,
        error: row.error,
        duration_ms: row.duration_ms,
        started_at: row.started_at,
        finished_at: row.finished_at,
      }));
    });
  }

  async getExecution(executionId: string): Promise<ExecutionResult | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select id, status, result, error, duration_ms, started_at, finished_at
          from eidan.procedure_executions
          where user_id=$1 and id=$2`,
        [currentPrincipal().id, executionId],
      );
      const row = r.rows[0] as { id: string; status: string; result: string | null; error: string | null; duration_ms: number | null; started_at: string; finished_at: string | null } | undefined;
      if (!row) return null;
      return {
        id: row.id,
        status: row.status as 'queued' | 'running' | 'completed' | 'failed',
        result: row.result ? JSON.parse(row.result) : null,
        error: row.error,
        duration_ms: row.duration_ms,
        started_at: row.started_at,
        finished_at: row.finished_at,
      };
    });
  }

  async updateExecution(executionId: string, status: 'queued' | 'running' | 'completed' | 'failed', result?: unknown, error?: string, durationMs?: number): Promise<ExecutionResult | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `update eidan.procedure_executions
         set status=$2, result=$3, error=$4, duration_ms=$5, finished_at=case when $2 != 'queued' and $2 != 'running' then now() else null end
         where user_id=$1 and id=$6
         returning id, status, result, error, duration_ms, started_at, finished_at`,
        [currentPrincipal().id, status, result ? JSON.stringify(result) : null, error, durationMs, executionId],
      );
      const row = r.rows[0] as { id: string; status: string; result: string | null; error: string | null; duration_ms: number | null; started_at: string; finished_at: string | null } | undefined;
      if (!row) return null;
      return {
        id: row.id,
        status: row.status as 'queued' | 'running' | 'completed' | 'failed',
        result: row.result ? JSON.parse(row.result) : null,
        error: row.error,
        duration_ms: row.duration_ms,
        started_at: row.started_at,
        finished_at: row.finished_at,
      };
    });
  }
}
