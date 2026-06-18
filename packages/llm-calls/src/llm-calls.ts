// SPDX-License-Identifier: AGPL-3.0-or-later
import { Db } from './db.js';

export interface LlmCall {
  userId: string;
  conversationId?: string;
  messageId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  requestId?: string;
  role?: string;
}

export interface LlmCalls {
  record(call: LlmCall): Promise<void>;
}

// One row per provider call (eidan.llm_calls). Telemetry must never break a turn, so failures are
// logged, never thrown.
export class LlmCallsImpl implements LlmCalls {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async record(c: LlmCall): Promise<void> {
    try {
      await this.db.query(
        `insert into eidan.llm_calls
           (user_id, conversation_id, message_id, role, provider, model, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, cost_usd, request_id, started_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
        [
          c.userId, c.conversationId ?? null, c.messageId ?? null, c.role ?? 'primary', c.provider, c.model,
          c.inputTokens, c.outputTokens, c.cacheReadTokens ?? 0, c.cacheCreationTokens ?? 0,
          c.costUsd ?? 0, c.requestId ?? null,
        ],
      );
    } catch (e) {
      console.warn(`[llm-calls] record failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
