// SPDX-License-Identifier: AGPL-3.0-or-later
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';

export interface RoutineRow {
  id: string;
  user_id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
}

export interface CreateRoutineArgs {
  name: string;
  schedule: string;
  prompt: string;
}

export interface UpdateRoutineArgs {
  name?: string;
  schedule?: string;
  prompt?: string;
  enabled?: boolean;
}

const COLS = 'id, user_id, name, schedule, prompt, enabled, last_run_at, created_at';

function uid(): string {
  const p = tryCurrentPrincipal();
  if (!p) throw new Error('no user context — routines are owner-scoped');
  return p.id;
}

// The routines store: per-user CRUD for the tools (principal-scoped), plus the cross-user queries the
// background loop needs (it scans every owner's enabled routines, so those bypass the principal).
export class RoutinesStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async create(args: CreateRoutineArgs): Promise<RoutineRow> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into eidan.routines (user_id, name, schedule, prompt)
         values ($1, $2, $3, $4) returning ${COLS}`,
        [userId, args.name, args.schedule, args.prompt],
      );
      return r.rows[0] as RoutineRow;
    });
  }

  async list(): Promise<RoutineRow[]> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${COLS} from eidan.routines
         where user_id = $1 and deleted_at is null order by created_at`,
        [userId],
      );
      return r.rows as RoutineRow[];
    });
  }

  async update(id: string, patch: UpdateRoutineArgs): Promise<RoutineRow | null> {
    const userId = uid();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name); }
    if (patch.schedule !== undefined) { sets.push(`schedule = $${i++}`); vals.push(patch.schedule); }
    if (patch.prompt !== undefined) { sets.push(`prompt = $${i++}`); vals.push(patch.prompt); }
    if (patch.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(patch.enabled); }
    if (sets.length === 0) {
      const cur = await this.list();
      return cur.find((r) => r.id === id) ?? null;
    }
    vals.push(id, userId);
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `update eidan.routines set ${sets.join(', ')}
         where id = $${i++} and user_id = $${i} and deleted_at is null returning ${COLS}`,
        vals,
      );
      return (r.rows[0] as RoutineRow | undefined) ?? null;
    });
  }

  async remove(id: string): Promise<boolean> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `update eidan.routines set deleted_at = now()
         where id = $1 and user_id = $2 and deleted_at is null`,
        [id, userId],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  // ----- cross-user, used only by the background loop (no ambient principal) -----

  async dueScan(): Promise<RoutineRow[]> {
    const r = await this.db.query(
      `select ${COLS} from eidan.routines where enabled and deleted_at is null`,
    );
    return r.rows as RoutineRow[];
  }

  async userTimeZone(userId: string): Promise<string> {
    const r = await this.db.query(
      `select value from eidan.user_context
       where user_id = $1 and category = 'preferences' and key = 'timezone' and deleted_at is null
       limit 1`,
      [userId],
    );
    const raw = r.rows[0]?.['value'];
    const tz = typeof raw === 'string' ? raw : null;
    return tz ?? 'UTC';
  }

  // Claim a fire window. The unique (routine_id, fired_for) index means exactly one node wins; the
  // others get a no-op insert and skip. Returns true if THIS caller claimed the window.
  async claimRun(routineId: string, userId: string, firedFor: string): Promise<boolean> {
    const r = await this.db.query(
      `insert into eidan.routine_runs (routine_id, user_id, fired_for)
       values ($1, $2, $3) on conflict (routine_id, fired_for) do nothing returning id`,
      [routineId, userId, firedFor],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async finishRun(routineId: string, firedFor: string, status: 'delivered' | 'failed', detail: string): Promise<void> {
    await this.db.query(
      `update eidan.routine_runs set status = $3, detail = $4 where routine_id = $1 and fired_for = $2`,
      [routineId, firedFor, status, detail.slice(0, 4000)],
    );
    if (status === 'delivered') {
      await this.db.query(`update eidan.routines set last_run_at = now() where id = $1`, [routineId]);
    }
  }
}
