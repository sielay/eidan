// SPDX-License-Identifier: AGPL-3.0-or-later
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';

export type Severity = 'low' | 'medium' | 'high';
export type EscalationStatus = 'pending' | 'acknowledged' | 'resolved' | 'open' | 'responded' | 'rejected';
export type EscalationType = 'agent_to_operator' | 'agent_to_agent' | 'operator_to_agent' | 'operator_prompt' | 'decision_gate';

export interface RaiseArgs {
  severity: Severity;
  /** One of the eidan.escalations reason_class enum; unknown values coerce to 'other'. */
  reasonClass: string;
  suggestedAction?: string;
  evidence?: unknown[];
  metadata?: Record<string, unknown>;
  /** The eidan.agents id this is about. Stored in metadata.agent_id (the FK agent_id column references
   *  agent_context personas, not eidan.agents) and used to dedupe — one pending escalation per agent. */
  agentId?: string;
  conversationId?: string;
  /** Explicit owner for background callers with no ambient principal; else taken from the principal. */
  userId?: string;
  /** V2: which agent raised this escalation */
  fromAgent?: string;
  /** V2: which agent should consume the response */
  toAgent?: string;
  /** V2: type of escalation (defaults to agent_to_operator for backwards compat) */
  escalationType?: EscalationType;
  /** V2: how should the next agent act on this */
  triggerPrompt?: string;
}

export interface RespondArgs {
  id: string;
  feedback: string;
  reasoning?: string;
  decision?: string;
  tags?: string[];
  nextAgent?: string;
  userId?: string;
}

export interface EscalationRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  agent_id: string | null;
  severity: Severity;
  reason_class: string;
  suggested_action: string | null;
  evidence: unknown[];
  status: EscalationStatus;
  metadata: Record<string, unknown>;
  from_agent: string | null;
  to_agent: string | null;
  escalation_type: EscalationType;
  response: { feedback?: string; reasoning?: string; decision?: string; tags?: string[]; next_agent?: string } | null;
  trigger_prompt: string | null;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
  resolved_at: string | null;
  responded_by: string | null;
}

// The registered service interface other plugins consume via services.Escalations.
export interface EscalationsService {
  raise(args: RaiseArgs): Promise<{ id: string } | null>;
  respond(args: RespondArgs): Promise<{ id: string } | null>;
  list(args: { userId?: string; fromAgent?: string; toAgent?: string; status?: EscalationStatus; limit?: number }): Promise<EscalationRow[]>;
}

const VALID_REASONS = new Set([
  'missing_input', 'permission_denied', 'external_failure', 'ambiguous_intent',
  'over_budget', 'over_capacity', 'no_progress', 'unrecoverable_error', 'other',
]);
const VALID_SEVERITY = new Set<Severity>(['low', 'medium', 'high']);
const VALID_TYPES = new Set<EscalationType>(['agent_to_operator', 'agent_to_agent', 'operator_to_agent', 'operator_prompt', 'decision_gate']);
const VALID_STATUS = new Set<EscalationStatus>(['pending', 'acknowledged', 'resolved', 'open', 'responded', 'rejected']);

export class EscalationsStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Insert an escalation (deduped per agent: a pending escalation for the same agent is not
  // duplicated). Returns the new row id, or null when deduped. Pure DB — notify emission is the
  // service wrapper's job (index.ts), so both the tool and auto-escalation share one delivery path.
  async insert(args: RaiseArgs): Promise<{ id: string } | null> {
    const userId = args.userId ?? tryCurrentPrincipal()?.id;
    if (!userId) throw new Error('escalations: no user context (user_id is required)');
    const reasonClass = VALID_REASONS.has(args.reasonClass) ? args.reasonClass : 'other';
    const severity: Severity = VALID_SEVERITY.has(args.severity) ? args.severity : 'medium';
    const escalationType: EscalationType = VALID_TYPES.has(args.escalationType ?? 'agent_to_operator')
      ? (args.escalationType ?? 'agent_to_operator')
      : 'agent_to_operator';

    if (args.agentId) {
      const ex = await this.db.query(
        `select 1 from eidan.escalations
          where user_id = $1 and status = 'pending' and metadata->>'agent_id' = $2 limit 1`,
        [userId, args.agentId],
      );
      if ((ex.rowCount ?? 0) > 0) return null;
    }

    const metadata = { ...(args.metadata ?? {}), ...(args.agentId ? { agent_id: args.agentId } : {}) };
    const r = await this.db.query(
      `insert into eidan.escalations
         (user_id, conversation_id, severity, reason_class, suggested_action, evidence, metadata, from_agent, to_agent, escalation_type, trigger_prompt, status)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12) returning id`,
      [
        userId, args.conversationId ?? null, severity, reasonClass, args.suggestedAction ?? null,
        JSON.stringify(args.evidence ?? []), JSON.stringify(metadata),
        args.fromAgent ?? null, args.toAgent ?? null, escalationType, args.triggerPrompt ?? null,
        escalationType === 'agent_to_agent' ? 'open' : 'pending',
      ],
    );
    return { id: r.rows[0]?.['id'] as string };
  }

  // Respond to an escalation with feedback and decision
  async respond(args: RespondArgs): Promise<{ id: string } | null> {
    const respondingUserId = args.userId ?? tryCurrentPrincipal()?.id;
    if (!respondingUserId) throw new Error('escalations: no user context (user_id is required for respond)');

    const esc = await this.db.query(
      `select id, status from eidan.escalations where id = $1`,
      [args.id],
    );
    if ((esc.rowCount ?? 0) === 0) return null;

    const row = esc.rows[0] as Record<string, unknown>;
    const status = row.status as EscalationStatus;
    if (status !== 'pending' && status !== 'open' && status !== 'acknowledged') {
      return null;
    }

    const response = {
      feedback: args.feedback,
      reasoning: args.reasoning,
      decision: args.decision,
      tags: args.tags,
      next_agent: args.nextAgent,
    };

    const r = await this.db.query(
      `update eidan.escalations
       set status = 'responded', response = $2::jsonb, responded_at = now(), responded_by = $3, updated_at = now()
       where id = $1
       returning id`,
      [args.id, JSON.stringify(response), respondingUserId],
    );
    return { id: r.rows[0]?.['id'] as string };
  }

  // Query escalations with optional filters (used by agents to check for responses)
  async list(args: { userId?: string; fromAgent?: string; toAgent?: string; status?: EscalationStatus; limit?: number }): Promise<EscalationRow[]> {
    const userId = args.userId ?? tryCurrentPrincipal()?.id;
    if (!userId) throw new Error('escalations: no user context (user_id is required for list)');

    const params: unknown[] = [userId];
    let where = 'user_id = $1 and deleted_at is null';
    let paramIdx = 2;

    if (args.toAgent) {
      params.push(args.toAgent);
      where += ` and to_agent = $${paramIdx++}`;
    }
    if (args.fromAgent) {
      params.push(args.fromAgent);
      where += ` and from_agent = $${paramIdx++}`;
    }
    if (args.status) {
      params.push(args.status);
      where += ` and status = $${paramIdx++}`;
    }

    const limit = Math.min(args.limit ?? 100, 500);
    const r = await this.db.query(
      `select id, user_id, conversation_id, agent_id, severity, reason_class, suggested_action,
              evidence, status, metadata, from_agent, to_agent, escalation_type, response,
              trigger_prompt, created_at, updated_at, responded_at, resolved_at, responded_by
         from eidan.escalations where ${where}
         order by created_at desc limit $${paramIdx}`,
      [...params, limit],
    );
    return r.rows as EscalationRow[];
  }
}
