// SPDX-License-Identifier: AGPL-3.0-or-later
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';

export type Severity = 'low' | 'medium' | 'high';

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
}

// The registered service interface other plugins consume via services.Escalations.
export interface EscalationsService {
  raise(args: RaiseArgs): Promise<{ id: string } | null>;
}

const VALID_REASONS = new Set([
  'missing_input', 'permission_denied', 'external_failure', 'ambiguous_intent',
  'over_budget', 'over_capacity', 'no_progress', 'unrecoverable_error', 'other',
]);
const VALID_SEVERITY = new Set<Severity>(['low', 'medium', 'high']);

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
         (user_id, conversation_id, severity, reason_class, suggested_action, evidence, metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) returning id`,
      [
        userId, args.conversationId ?? null, severity, reasonClass, args.suggestedAction ?? null,
        JSON.stringify(args.evidence ?? []), JSON.stringify(metadata),
      ],
    );
    return { id: r.rows[0]?.['id'] as string };
  }
}
