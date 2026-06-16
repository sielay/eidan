// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure DB-row -> matbot-domain mappers (type-only matbot imports, erased at runtime), so the
// conversation/message projection is unit-testable away from the pg-backed store.
import type { Session, Message, MessageContent } from '@matatbread/matbot-plugin-api';

export interface ConvRow {
  id: string; user_id: string; title: string | null; status: string; persona: string | null;
  contexts: unknown; parent_conversation_id: string | null; origin_message_id: string | null;
  version: string; created_at: Date; updated_at: Date;
}
export interface MsgRow {
  id: string; role: Message['role']; content_blocks: MessageContent[];
  provider: string | null; trace_id: string | null; metadata: Record<string, unknown>; created_at: Date;
}

export function rowToSession(c: ConvRow, messages: Message[]): Session {
  return {
    id: c.id,
    version: String(c.version),
    ownerPrincipalId: c.user_id,
    status: c.status as Session['status'],
    contexts: (c.contexts as string[] | null) ?? [],
    messages,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
    ...(c.title != null ? { title: c.title } : {}),
    ...(c.persona != null ? { persona: c.persona } : {}),
    ...(c.parent_conversation_id != null ? { parentSessionId: c.parent_conversation_id } : {}),
    ...(c.origin_message_id != null ? { branchPointMessageId: c.origin_message_id } : {}),
  };
}

export function rowToMessage(m: MsgRow): Message {
  return {
    id: m.id,
    role: m.role,
    content: m.content_blocks, // jsonb round-trips the full block array losslessly
    createdAt: m.created_at.toISOString(),
    traceId: m.trace_id ?? '',
    ...(m.provider != null ? { providerName: m.provider } : {}),
    ...(m.metadata && Object.keys(m.metadata).length ? { metadata: m.metadata } : {}),
  };
}
