// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

export interface AgentRelationship {
  id: string;
  user_id: string;
  from_agent_name: string;
  to_agent_name: string;
  relationship_type: "reads_from" | "writes_to" | "asks" | "depends_on" | "notifies";
  strength: number;
  description?: string;
}

/**
 * One row from ``GET /api/escalations`` — mirrors the backend
 * envelope from `docs/022 §3`. The inbox renders these grouped by
 * status (pending first); the operator advances each one through
 * acknowledged → resolved via the two POST endpoints below.
 */
export interface EscalationSummary {
  id: string;
  conversation_id: string | null;
  agent_id: string | null;
  severity: "low" | "medium" | "high";
  reason_class: string;
  suggested_action: string | null;
  // Contract is string[], but legacy/auto-escalated rows may carry jsonb objects
  // (e.g. {error, fire_key}); the UI must defensively stringify. See evidenceText().
  evidence: Array<string | Record<string, unknown>>;
  metadata: Record<string, unknown>;
  status: "pending" | "acknowledged" | "resolved" | "open" | "responded" | "rejected";
  from_agent: string | null;
  to_agent: string | null;
  escalation_type: "agent_to_operator" | "agent_to_agent" | "operator_to_agent" | "operator_prompt" | "decision_gate";
  response: { feedback?: string; reasoning?: string; decision?: string; tags?: string[]; next_agent?: string } | null;
  trigger_prompt: string | null;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
  resolved_at: string | null;
}

interface ListResponse {
  escalations: EscalationSummary[];
}

export type EscalationStatusFilter =
  | "pending"
  | "acknowledged"
  | "resolved"
  | "all";

export async function listEscalations(
  options: { status?: EscalationStatusFilter; limit?: number } = {},
): Promise<EscalationSummary[]> {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  const res = await authFetch(
    `/api/escalations${qs ? `?${qs}` : ""}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`GET /api/escalations returned ${res.status}`);
  }
  const body = (await res.json()) as ListResponse;
  return body.escalations;
}

export async function acknowledgeEscalation(
  id: string,
): Promise<void> {
  const res = await authFetch(
    `/api/escalations/${id}/acknowledge`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(
      `POST /api/escalations/${id}/acknowledge returned ${res.status}`,
    );
  }
}

export async function resolveEscalation(
  id: string,
): Promise<void> {
  const res = await authFetch(
    `/api/escalations/${id}/resolve`,
    { method: "POST", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(
      `POST /api/escalations/${id}/resolve returned ${res.status}`,
    );
  }
}

export async function respondEscalation(
  id: string,
  response: {
    feedback: string;
    reasoning?: string;
    decision?: string;
    tags?: string[];
    next_agent?: string;
  },
): Promise<void> {
  const res = await authFetch(
    `/api/escalations/${id}/respond`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(response),
    },
  );
  if (!res.ok) {
    throw new Error(
      `POST /api/escalations/${id}/respond returned ${res.status}`,
    );
  }
}

interface ListAgentRelationshipsResponse {
  relationships: AgentRelationship[];
}

export async function listAgentRelationships(
  userId: string,
  options?: { fromAgent?: string; toAgent?: string },
): Promise<AgentRelationship[]> {
  const params = new URLSearchParams();
  params.set("user_id", userId);
  if (options?.fromAgent) params.set("from", options.fromAgent);
  if (options?.toAgent) params.set("to", options.toAgent);
  const qs = params.toString();
  const res = await authFetch(
    `/api/agent-relationships${qs ? `?${qs}` : ""}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`GET /api/agent-relationships returned ${res.status}`);
  }
  const body = (await res.json()) as ListAgentRelationshipsResponse;
  return body.relationships;
}
