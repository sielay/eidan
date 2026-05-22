"use client";

import { authFetch } from "@/lib/auth";

/**
 * One block in the assistant row's ``tool_calls`` jsonb array. Shape
 * mirrors `eidan_backend.persistence.insert_assistant_message` — the
 * `id` is the provider-issued tool_use id and is the join key for the
 * matching :class:`ToolResultBlock`.
 */
export interface ToolCallBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * One block in a tool row's ``tool_results`` jsonb array. Shape
 * mirrors `eidan_backend.persistence.insert_tool_message`.
 */
export interface ToolResultBlock {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

/**
 * Replay shape of a single message row, mirroring the backend's
 * ``GET /api/conversations/{id}/messages`` payload (`docs/014 §4.2`,
 * `docs/003 §3`). The backend is authoritative; the UI does not
 * synthesise message ids or timestamps locally.
 *
 * ``content`` is nullable because `eidan.messages.content` is nullable
 * — tool-call-only assistant turns and `role='tool'` rows persist with
 * ``content = NULL``. ``tool_calls`` is populated on assistant rows,
 * ``tool_results`` on tool rows; both default to an empty array on the
 * server side, so the wire always carries an array.
 */
export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls: ToolCallBlock[];
  tool_results: ToolResultBlock[];
  parent_message_id: string | null;
  provider: string | null;
  model: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface MessagesResponse {
  messages: MessageRow[];
}

export async function fetchConversationMessages(
  conversationId: string,
): Promise<MessageRow[]> {
  const res = await authFetch(
    `/api/conversations/${conversationId}/messages`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(
      `GET /api/conversations/${conversationId}/messages returned ${res.status}`,
    );
  }
  const body = (await res.json()) as MessagesResponse;
  return body.messages;
}

/**
 * Sidebar row shape, mirroring the backend's
 * ``GET /api/conversations`` payload (`docs/014 §3`, `docs/003 §2`).
 */
export interface ConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationsResponse {
  conversations: ConversationSummary[];
}

export async function listConversations(
): Promise<ConversationSummary[]> {
  const res = await authFetch("/api/conversations", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/conversations returned ${res.status}`);
  }
  const body = (await res.json()) as ConversationsResponse;
  return body.conversations;
}

interface CreateConversationResponse {
  id: string;
  title: string | null;
}

export async function createConversation(
  title?: string | null,
): Promise<CreateConversationResponse> {
  const res = await authFetch("/api/conversations", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: JSON.stringify({ title: title ?? null }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/conversations returned ${res.status}`);
  }
  return (await res.json()) as CreateConversationResponse;
}
