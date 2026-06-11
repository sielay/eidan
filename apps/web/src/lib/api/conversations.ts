// SPDX-License-Identifier: AGPL-3.0-or-later
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

/**
 * Fetch a single conversation row by id. Used by the chat-view
 * header so the title can render without pulling the whole sidebar
 * payload.
 */
export async function fetchConversation(
  conversationId: string,
): Promise<ConversationSummary> {
  const res = await authFetch(`/api/conversations/${conversationId}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `GET /api/conversations/${conversationId} returned ${res.status}`,
    );
  }
  return (await res.json()) as ConversationSummary;
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

interface UpdateConversationResponse {
  id: string;
  title: string | null;
}

/**
 * PATCH a conversation's title (issue #48). Pass ``null`` (or omit) to
 * clear the title back to autogen-eligible state; the backend trims
 * whitespace and collapses empty strings to ``null``.
 */
export async function updateConversationTitle(
  conversationId: string,
  title: string | null,
): Promise<UpdateConversationResponse> {
  const res = await authFetch(
    `/api/conversations/${conversationId}`,
    {
      method: "PATCH",
      headers: { Accept: "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `PATCH /api/conversations/${conversationId} returned ${res.status}`,
    );
  }
  return (await res.json()) as UpdateConversationResponse;
}

/**
 * Force-regenerate a conversation's title from its first user +
 * assistant exchange. The backend runs a one-shot haiku-class summary
 * inline and returns the new title.
 */
export async function regenerateConversationTitle(
  conversationId: string,
): Promise<UpdateConversationResponse> {
  const res = await authFetch(
    `/api/conversations/${conversationId}/regenerate_title`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    throw new Error(
      `POST /api/conversations/${conversationId}/regenerate_title returned ${res.status}`,
    );
  }
  return (await res.json()) as UpdateConversationResponse;
}
