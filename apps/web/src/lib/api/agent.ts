// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/**
 * Wire shape of ``GET /api/agent`` / ``PUT /api/agent`` (`docs/003 §1`'s
 * ``eidan.agent_context`` row, with the effective persona pre-resolved
 * by the backend so the UI doesn't replicate the merge logic).
 */
export interface AgentRow {
  id: string;
  agent_slug: string;
  display_name: string;
  description: string | null;
  enabled: boolean;
  code_defaults: Record<string, unknown>;
  user_overrides: Record<string, unknown>;
  /** ``user_overrides.system_prompt → code_defaults.system_prompt → null``. */
  persona: string | null;
  updated_at: string;
}

interface AgentResponse {
  agent: AgentRow;
}

export async function fetchAgent(
): Promise<AgentRow> {
  const res = await authFetch("/api/agent", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/agent returned ${res.status}`);
  }
  const body = (await res.json()) as AgentResponse;
  return body.agent;
}

export async function putAgentPersona(
  persona: string | null,
): Promise<AgentRow> {
  const res = await authFetch("/api/agent", {
    method: "PUT",
    headers: { Accept: "application/json" },
    body: JSON.stringify({ persona }),
  });
  if (!res.ok) {
    throw new Error(`PUT /api/agent returned ${res.status}`);
  }
  const body = (await res.json()) as AgentResponse;
  return body.agent;
}
