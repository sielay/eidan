// SPDX-License-Identifier: AGPL-3.0-or-later
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';

export type Severity = 'low' | 'medium' | 'high';
export type EscalationStatus = 'pending' | 'acknowledged' | 'resolved' | 'open' | 'responded' | 'rejected';
export type EscalationType = 'agent_to_operator' | 'agent_to_agent' | 'operator_to_agent' | 'operator_prompt' | 'decision_gate';
export type RelationshipType = 'reads_from' | 'writes_to' | 'asks' | 'depends_on' | 'notifies';

const VALID_RELATIONSHIP_TYPES = new Set<RelationshipType>(['reads_from', 'writes_to', 'asks', 'depends_on', 'notifies']);

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
  fromAgent?: string | undefined;
  /** V2: which agent should consume the response */
  toAgent?: string | undefined;
  /** V2: type of escalation (defaults to agent_to_operator for backwards compat) */
  escalationType?: EscalationType | undefined;
  /** V2: how should the next agent act on this */
  triggerPrompt?: string | undefined;
}

export interface RespondArgs {
  id: string;
  feedback: string;
  reasoning?: string | undefined;
  decision?: string | undefined;
  tags?: string[] | undefined;
  nextAgent?: string | undefined;
  userId?: string | undefined;
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
  agent_response_processed_at: string | null;
}

export interface AgentRelationship {
  id: string;
  user_id: string;
  from_agent_id: string;
  to_agent_id: string;
  relationship_type: RelationshipType;
  strength: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// The registered service interface other plugins consume via services.Escalations.
export interface EscalationsService {
  raise(args: RaiseArgs): Promise<{ id: string } | null>;
  respond(args: RespondArgs): Promise<{ id: string } | null>;
  list(args: { userId?: string | undefined; fromAgent?: string | undefined; toAgent?: string | undefined; status?: EscalationStatus | undefined; limit?: number | undefined }): Promise<EscalationRow[]>;
  // Cross-user (no ambient principal): the agents response loop's scan for still-unprocessed
  // 'responded' escalations addressed to the given response-triggered agents.
  listUnprocessedResponsesForAgents(toAgentIds: string[], limit?: number): Promise<EscalationRow[]>;
  markResponseProcessed(id: string): Promise<void>;
  listAgentRelationships(userId: string, options?: { fromAgentId?: string; toAgentId?: string }): Promise<AgentRelationship[]>;
  setAgentRelationship(userId: string, rel: { fromAgentId: string; toAgentId: string; type: RelationshipType; strength?: number; description?: string }): Promise<AgentRelationship>;
  deleteAgentRelationship(userId: string, fromAgentId: string, toAgentId: string): Promise<void>;
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
  async list(args: { userId?: string | undefined; fromAgent?: string | undefined; toAgent?: string | undefined; status?: EscalationStatus | undefined; limit?: number | undefined }): Promise<EscalationRow[]> {
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
              trigger_prompt, created_at, updated_at, responded_at, resolved_at, responded_by,
              agent_response_processed_at
         from eidan.escalations where ${where}
         order by created_at desc limit $${paramIdx}`,
      [...params, limit],
    );
    return r.rows as EscalationRow[];
  }

  // Fetch a single escalation by id (internal; used to emit response events)
  async getEscalation(id: string): Promise<EscalationRow | null> {
    const r = await this.db.query(
      `select id, user_id, conversation_id, agent_id, severity, reason_class, suggested_action,
              evidence, status, metadata, from_agent, to_agent, escalation_type, response,
              trigger_prompt, created_at, updated_at, responded_at, resolved_at, responded_by,
              agent_response_processed_at
         from eidan.escalations where id = $1`,
      [id],
    );
    return (r.rows[0] as EscalationRow | undefined) ?? null;
  }

  // Cross-user (no ambient principal): every owner's still-unprocessed 'responded' escalation addressed
  // to one of the given response-triggered agents. Mirrors the agents loop's other cross-user scans
  // (e.g. dueScheduleScan) — only the background dispatch loop calls it, so it bypasses the principal.
  async listUnprocessedResponsesForAgents(toAgentIds: string[], limit = 20): Promise<EscalationRow[]> {
    if (toAgentIds.length === 0) return [];
    const r = await this.db.query(
      `select id, user_id, conversation_id, agent_id, severity, reason_class, suggested_action,
              evidence, status, metadata, from_agent, to_agent, escalation_type, response,
              trigger_prompt, created_at, updated_at, responded_at, resolved_at, responded_by,
              agent_response_processed_at
         from eidan.escalations
        where status = 'responded' and deleted_at is null
          and agent_response_processed_at is null
          and to_agent = any($1::text[])
        order by responded_at asc nulls last
        limit $2`,
      [toAgentIds, Math.min(limit, 200)],
    );
    return r.rows as EscalationRow[];
  }

  // Mark an escalation response as processed by the agent system (idempotent)
  async markResponseProcessed(id: string): Promise<void> {
    await this.db.query(
      `update eidan.escalations set agent_response_processed_at = now()
       where id = $1 and agent_response_processed_at is null`,
      [id],
    );
  }

  // List agent relationships for the given user with optional filters
  async listAgentRelationships(userId: string, options?: { fromAgentId?: string; toAgentId?: string }): Promise<AgentRelationship[]> {
    const params: unknown[] = [userId];
    let where = 'user_id = $1';
    let paramIdx = 2;

    if (options?.fromAgentId) {
      params.push(options.fromAgentId);
      where += ` and from_agent_id = $${paramIdx++}`;
    }
    if (options?.toAgentId) {
      params.push(options.toAgentId);
      where += ` and to_agent_id = $${paramIdx++}`;
    }

    const r = await this.db.query(
      `select id, user_id, from_agent_id, to_agent_id, relationship_type, strength, description, created_at, updated_at
         from eidan.agent_relationships where ${where}
         order by from_agent_id, to_agent_id`,
      params,
    );
    return r.rows as AgentRelationship[];
  }

  // Create or update an agent relationship
  async setAgentRelationship(userId: string, rel: { fromAgentId: string; toAgentId: string; type: RelationshipType; strength?: number; description?: string }): Promise<AgentRelationship> {
    if (!VALID_RELATIONSHIP_TYPES.has(rel.type)) {
      throw new Error(`Invalid relationship type: ${rel.type}. Must be one of: ${Array.from(VALID_RELATIONSHIP_TYPES).join(', ')}`);
    }
    const strength = Math.min(Math.max(rel.strength ?? 3, 1), 5);

    // Validate and sanitize description field
    let description = rel.description ?? null;
    if (description) {
      if (typeof description !== 'string') {
        throw new Error('Description must be a string');
      }
      if (description.length > 1000) {
        throw new Error('Description must be 1000 characters or less');
      }
    }

    const r = await this.db.query(
      `insert into eidan.agent_relationships
         (user_id, from_agent_id, to_agent_id, relationship_type, strength, description)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, from_agent_id, to_agent_id) do update set
         relationship_type = $4, strength = $5, description = $6, updated_at = now()
       returning id, user_id, from_agent_id, to_agent_id, relationship_type, strength, description, created_at, updated_at`,
      [userId, rel.fromAgentId, rel.toAgentId, rel.type, strength, description],
    );
    return r.rows[0] as AgentRelationship;
  }

  // Delete an agent relationship
  async deleteAgentRelationship(userId: string, fromAgentId: string, toAgentId: string): Promise<void> {
    await this.db.query(
      `delete from eidan.agent_relationships where user_id = $1 and from_agent_id = $2 and to_agent_id = $3`,
      [userId, fromAgentId, toAgentId],
    );
  }
}
