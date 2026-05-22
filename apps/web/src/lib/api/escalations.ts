"use client";

import { authFetch } from "@/lib/auth";

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
  evidence: string[];
  metadata: Record<string, unknown>;
  status: "pending" | "acknowledged" | "resolved";
  created_at: string;
  updated_at: string;
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
