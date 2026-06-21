// SPDX-License-Identifier: AGPL-3.0-or-later
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';

export interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  persona: string;
  provider: string | null;
  model: string | null;
  target_node: string | null;
  enabled: boolean;
  created_at: string;
}

export interface TriggerRow {
  id: string;
  agent_id: string;
  user_id: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

// A schedule trigger joined with its (enabled) agent — the unit the dispatch loop fires.
export interface DueScheduleRow {
  trigger_id: string;
  agent_id: string;
  user_id: string;
  name: string;
  persona: string;
  provider: string | null;
  model: string | null;
  target_node: string | null;
  schedule: string;
}

export interface CreateAgentArgs {
  name: string;
  persona: string;
  provider?: string | null;
  model?: string | null;
  target_node?: string | null;
}

export interface UpdateAgentArgs {
  name?: string;
  persona?: string;
  provider?: string | null;
  model?: string | null;
  target_node?: string | null;
  enabled?: boolean;
}

const A_COLS = 'id, user_id, name, persona, provider, model, target_node, enabled, created_at';
const T_COLS = 'id, agent_id, user_id, type, config, enabled, created_at';

function uid(): string {
  const p = tryCurrentPrincipal();
  if (!p) throw new Error('no user context — agents are owner-scoped');
  return p.id;
}

// The agents store: per-user CRUD for agents + their triggers (principal-scoped), plus the cross-user
// queries the dispatch loop needs (it scans every owner's enabled schedule triggers, bypassing the
// principal). Same shape + dedup guard as @eidandev/routines.
export class AgentsStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ----- agent CRUD (principal-scoped) -----

  async createAgent(args: CreateAgentArgs): Promise<AgentRow> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `insert into eidan.agents (user_id, name, persona, provider, model, target_node)
         values ($1, $2, $3, $4, $5, $6) returning ${A_COLS}`,
        [userId, args.name, args.persona, args.provider ?? null, args.model ?? null, args.target_node ?? null],
      );
      return r.rows[0] as AgentRow;
    });
  }

  async listAgents(): Promise<AgentRow[]> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${A_COLS} from eidan.agents
         where user_id = $1 and deleted_at is null order by created_at`,
        [userId],
      );
      return r.rows as AgentRow[];
    });
  }

  // A single agent by id, scoped to its owner — used by the manual "run now" path.
  async getAgent(id: string, userId: string): Promise<AgentRow | null> {
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${A_COLS} from eidan.agents where id = $1 and user_id = $2 and deleted_at is null`,
        [id, userId],
      );
      return (r.rows[0] as AgentRow | undefined) ?? null;
    });
  }

  // Manual fire ("run now", for testing). Wired in index.ts (it needs `services` + run opts, which the
  // data layer doesn't hold). Resolves with the conversation id as soon as it's created — the turn runs
  // detached — or null if the agent doesn't exist. Unlike scheduled fires it records no agent_runs row
  // (that ledger is keyed by a trigger), so a test never pollutes run history or the notify topic.
  runNow?: (agentId: string, userId: string) => Promise<{ conversationId: string } | null>;

  async updateAgent(id: string, patch: UpdateAgentArgs): Promise<AgentRow | null> {
    const userId = uid();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name); }
    if (patch.persona !== undefined) { sets.push(`persona = $${i++}`); vals.push(patch.persona); }
    if (patch.provider !== undefined) { sets.push(`provider = $${i++}`); vals.push(patch.provider); }
    if (patch.model !== undefined) { sets.push(`model = $${i++}`); vals.push(patch.model); }
    if (patch.target_node !== undefined) { sets.push(`target_node = $${i++}`); vals.push(patch.target_node); }
    if (patch.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(patch.enabled); }
    if (sets.length === 0) {
      const cur = await this.listAgents();
      return cur.find((a) => a.id === id) ?? null;
    }
    vals.push(id, userId);
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `update eidan.agents set ${sets.join(', ')}
         where id = $${i++} and user_id = $${i} and deleted_at is null returning ${A_COLS}`,
        vals,
      );
      return (r.rows[0] as AgentRow | undefined) ?? null;
    });
  }

  async removeAgent(id: string): Promise<boolean> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `update eidan.agents set deleted_at = now()
         where id = $1 and user_id = $2 and deleted_at is null`,
        [id, userId],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  // ----- trigger CRUD (principal-scoped) -----

  async addTrigger(agentId: string, type: string, config: Record<string, unknown>): Promise<TriggerRow> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const a = await q(
        `select id from eidan.agents where id = $1 and user_id = $2 and deleted_at is null`,
        [agentId, userId],
      );
      if ((a.rowCount ?? 0) === 0) throw new Error('no such agent');
      const r = await q(
        `insert into eidan.agent_triggers (agent_id, user_id, type, config)
         values ($1, $2, $3, $4) returning ${T_COLS}`,
        [agentId, userId, type, JSON.stringify(config)],
      );
      return r.rows[0] as TriggerRow;
    });
  }

  async listTriggers(agentId: string): Promise<TriggerRow[]> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `select ${T_COLS} from eidan.agent_triggers
         where agent_id = $1 and user_id = $2 and deleted_at is null order by created_at`,
        [agentId, userId],
      );
      return r.rows as TriggerRow[];
    });
  }

  async removeTrigger(id: string): Promise<boolean> {
    const userId = uid();
    return this.db.withPrincipalTx(async (q) => {
      const r = await q(
        `update eidan.agent_triggers set deleted_at = now()
         where id = $1 and user_id = $2 and deleted_at is null`,
        [id, userId],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  // ----- cross-user, used only by the dispatch loop (no ambient principal) -----

  async dueScheduleScan(): Promise<DueScheduleRow[]> {
    const r = await this.db.query(
      `select t.id as trigger_id, a.id as agent_id, a.user_id, a.name, a.persona, a.provider,
              a.model, a.target_node, t.config->>'schedule' as schedule
         from eidan.agent_triggers t
         join eidan.agents a on a.id = t.agent_id
        where t.type = 'schedule' and t.enabled and t.deleted_at is null
          and a.enabled and a.deleted_at is null
          and t.config ? 'schedule'`,
    );
    return r.rows as DueScheduleRow[];
  }

  // How many of this agent's most-recent runs failed in a row (0 if the latest delivered). Used by the
  // dispatch loop to escalate an agent that keeps failing.
  async recentFailureStreak(agentId: string): Promise<number> {
    const r = await this.db.query(
      `select status from eidan.agent_runs where agent_id = $1 order by created_at desc limit 20`,
      [agentId],
    );
    let n = 0;
    for (const row of r.rows as Array<{ status: string }>) {
      if (row.status === 'failed') n++;
      else break;
    }
    return n;
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

  // Claim a fire. The unique (trigger_id, fire_key) index means exactly one node wins; the others get
  // a no-op insert and skip. Returns true if THIS caller claimed the fire.
  async claimRun(triggerId: string, agentId: string, userId: string, fireKey: string): Promise<boolean> {
    const r = await this.db.query(
      `insert into eidan.agent_runs (agent_id, trigger_id, user_id, fire_key)
       values ($1, $2, $3, $4) on conflict (trigger_id, fire_key) do nothing returning id`,
      [agentId, triggerId, userId, fireKey],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // Tag the conversation an agent fire produced so the human chat sidebar can exclude it (the Agents
  // view surfaces it instead). Stamped at creation, before the turn runs, so it never flickers into
  // the list. metadata->>'origin' = 'agent' is the marker the frontend-agui conversation list filters.
  async markAgentConversation(conversationId: string, agentId: string, name: string): Promise<void> {
    await this.db.query(
      `update eidan.conversations
          set metadata = coalesce(metadata, '{}'::jsonb)
                         || jsonb_build_object('origin', 'agent', 'agent_id', $2::text, 'agent_name', $3::text)
        where id = $1`,
      [conversationId, agentId, name],
    );
  }

  async finishRun(
    triggerId: string,
    fireKey: string,
    status: 'delivered' | 'failed',
    detail: string,
    conversationId: string | null,
  ): Promise<void> {
    await this.db.query(
      `update eidan.agent_runs set status = $3, detail = $4, conversation_id = $5
       where trigger_id = $1 and fire_key = $2`,
      [triggerId, fireKey, status, detail.slice(0, 4000), conversationId],
    );
  }
}
