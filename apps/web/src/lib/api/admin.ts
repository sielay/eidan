// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/**
 * Wire shapes for /admin/activity. Each shape mirrors a backend
 * envelope pinned in `packages/schemas/schemas/core/admin/*.json`
 * (NodeList, NodeEventList, TriggerList). These hand-typed rows
 * are the consumer-side counterpart to the loose Zod schemas the
 * codegen emits — see the schemas commit for the rationale.
 */

export interface NodePluginInfo {
  name: string;
  version: string;
  tier: "core" | "pro" | "commercial" | string;
}

export interface NodeServedKind {
  kind: string;
  capacity: number;
}

export interface NodeInfo {
  node_id: string;
  node_type: "pi" | "fly" | "heroku" | "k8s" | "local" | string;
  status: "online" | "offline" | "degraded" | string;
  last_seen: string;
  seconds_since: number;
  metadata: Record<string, unknown>;
  plugins: NodePluginInfo[];
  // Job kinds this node serves from eidan.jobs, with per-kind capacity
  // (issue #249). Optional: legacy nodes / older backends omit it.
  served_kinds?: NodeServedKind[];
}

interface NodeListResponse {
  nodes: NodeInfo[];
}

export async function listAdminNodes(): Promise<NodeInfo[]> {
  const res = await authFetch("/api/admin/nodes", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/admin/nodes returned ${res.status}`);
  }
  const body = (await res.json()) as NodeListResponse;
  return body.nodes;
}

export interface NodeEvent {
  id: string;
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
  conversation_id: string | null;
}

interface NodeEventListResponse {
  node_id: string;
  events: NodeEvent[];
}

export async function listNodeEvents(
  nodeId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<NodeEventListResponse> {
  const params = new URLSearchParams();
  if (options.afterSeq !== undefined)
    params.set("after_seq", String(options.afterSeq));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const qs = params.toString();
  const path = `/api/admin/nodes/${encodeURIComponent(nodeId)}/events${qs ? `?${qs}` : ""}`;
  const res = await authFetch(path, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} returned ${res.status}`);
  }
  return (await res.json()) as NodeEventListResponse;
}

export interface TriggerInfo {
  behaviour_id: string;
  plugin: string;
  kind: "event" | "cron" | "schedule" | "webhook" | "agent" | "intent" | string;
  spec: string;
  next_run_ts: string | null;
}

export interface TriggerListResponse {
  triggers: TriggerInfo[];
  dlq_count: number;
}

export async function listAdminTriggers(): Promise<TriggerListResponse> {
  const res = await authFetch("/api/admin/triggers", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/admin/triggers returned ${res.status}`);
  }
  return (await res.json()) as TriggerListResponse;
}

// Mirrors core/admin/JobList.schema.json — a recency-bounded snapshot of
// the eidan.jobs delegation queue (#251).
export type JobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | string;

export interface JobInfo {
  id: string;
  kind: string;
  goal: string;
  status: JobStatus;
  surface: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  result: Record<string, unknown>;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface JobListResponse {
  jobs: JobInfo[];
}

export async function listAdminJobs(): Promise<JobInfo[]> {
  const res = await authFetch("/api/admin/jobs", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/admin/jobs returned ${res.status}`);
  }
  const body = (await res.json()) as JobListResponse;
  return body.jobs;
}
