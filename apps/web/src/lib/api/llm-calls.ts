// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/** Per-call telemetry row matching the backend's
 *  `GET /api/conversations/{id}/llm_calls` payload (#152).
 *
 *  The metadata blob carries whatever `capture_call_inputs` recorded —
 *  most rows have `system_prompt` and `user_text_excerpt`; some primary
 *  retry rows also have `iteration` / `retry_kind`. The UI tolerates
 *  missing keys.
 */
export interface LlmCallRow {
  id: string;
  message_id: string | null;
  role: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  error: string | null;
  error_type: string | null;
  request_id: string | null;
  started_at: string;
  finished_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface LlmCallsResponse {
  llm_calls: LlmCallRow[];
}

export async function listConversationLlmCalls(
  conversationId: string,
): Promise<LlmCallRow[]> {
  const res = await authFetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/llm_calls`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GET /api/conversations/${conversationId}/llm_calls returned ${res.status}`,
    );
  }
  const body = (await res.json()) as LlmCallsResponse;
  return body.llm_calls;
}
