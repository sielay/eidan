"use client";

import { CostSummary } from "@eidan/schemas";

import { authFetch } from "@/lib/auth";

/**
 * The three scopes pinned by ``docs/010 §6``: per-turn (keyed on the
 * latest message id), per-session (since the JWT's ``iat``), and the
 * rolling 24-hour day window. The backend's ``GET /api/cost/summary``
 * is authoritative for every shape the UI surfaces above the
 * conversation header (`docs/014 §4.4`).
 */
export type CostScope = CostSummary["scope"];
export type { CostSummary };

export async function fetchCostSummary(
  scope: CostScope,
  options: { messageId?: string | null; signal?: AbortSignal } = {},
): Promise<CostSummary> {
  const params = new URLSearchParams({ scope });
  if (scope === "turn" && options.messageId) {
    params.set("message_id", options.messageId);
  }
  const res = await authFetch(`/api/cost/summary?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(
      `GET /api/cost/summary?scope=${scope} returned ${res.status}`,
    );
  }
  return CostSummary.parse(await res.json());
}
