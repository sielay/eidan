// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/**
 * One row from ``GET /api/knowledge`` — the index payload the
 * browser renders. Body is omitted in the list to keep the response
 * compact; ``GET /api/knowledge/<id>`` returns the body for the
 * detail panel (`docs/014 §5`, `docs/017`).
 */
export interface KnowledgeSummary {
  id: string;
  slug: string | null;
  title: string | null;
  skill: string | null;
  updated_at: string;
  created_at: string;
}

export interface KnowledgeDetail extends KnowledgeSummary {
  body: string;
  source: string | null;
}

interface ListResponse {
  knowledge: KnowledgeSummary[];
}

interface DetailResponse {
  knowledge: KnowledgeDetail;
}

export async function listKnowledge(
  options: { skill?: string; limit?: number } = {},
): Promise<KnowledgeSummary[]> {
  const params = new URLSearchParams();
  if (options.skill) params.set("skill", options.skill);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  const res = await authFetch(
    `/api/knowledge${qs ? `?${qs}` : ""}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`GET /api/knowledge returned ${res.status}`);
  }
  const body = (await res.json()) as ListResponse;
  return body.knowledge;
}

export async function getKnowledgeRow(
  id: string,
): Promise<KnowledgeDetail> {
  const res = await authFetch(`/api/knowledge/${id}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/knowledge/${id} returned ${res.status}`);
  }
  const body = (await res.json()) as DetailResponse;
  return body.knowledge;
}

export interface KnowledgeUpdatePayload {
  title?: string;
  body?: string;
  skill?: string;
  expected_updated_at: string;
}

// Thrown when the server rejects a PATCH because the row's
// ``updated_at`` has moved since the operator's fetch — the UI
// shows the conflict, refetches, and lets the operator retry.
export class KnowledgeConflictError extends Error {
  constructor() {
    super(
      "knowledge row was modified since fetch — refresh and try again",
    );
    this.name = "KnowledgeConflictError";
  }
}

export async function updateKnowledgeRow(
  id: string,
  payload: KnowledgeUpdatePayload,
): Promise<KnowledgeDetail> {
  const res = await authFetch(`/api/knowledge/${id}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 409) {
    throw new KnowledgeConflictError();
  }
  if (!res.ok) {
    throw new Error(`PATCH /api/knowledge/${id} returned ${res.status}`);
  }
  const body = (await res.json()) as DetailResponse;
  return body.knowledge;
}

export async function deleteKnowledgeRow(id: string): Promise<void> {
  const res = await authFetch(`/api/knowledge/${id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`DELETE /api/knowledge/${id} returned ${res.status}`);
  }
}

/**
 * One node in a BFS traversal frontier around a seed knowledge row
 * (`docs/017 §5`). The `hops` field is the BFS depth — 0 for the
 * seed itself, 1 for direct outbound + backlink targets, 2 for
 * their neighbours, ...
 */
export interface KnowledgeNeighbour {
  id: string;
  slug: string | null;
  title: string | null;
  hops: number;
}

interface NeighboursResponse {
  seed_id: string;
  depth: number;
  neighbours: KnowledgeNeighbour[];
}

export async function getKnowledgeNeighbours(
  id: string,
  options: { depth?: number; limit?: number } = {},
): Promise<KnowledgeNeighbour[]> {
  const params = new URLSearchParams();
  if (options.depth !== undefined) params.set("depth", String(options.depth));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const qs = params.toString();
  const res = await authFetch(
    `/api/knowledge/${id}/neighbours${qs ? `?${qs}` : ""}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(
      `GET /api/knowledge/${id}/neighbours returned ${res.status}`,
    );
  }
  const body = (await res.json()) as NeighboursResponse;
  return body.neighbours;
}
