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
  payload: Record<string, unknown>;
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

/**
 * Cancel a live job or re-queue a settled one. Both POST to
 * `/api/admin/jobs/{id}/{action}` and return the job's resulting status.
 * The backend is idempotent on cancel and 409s a retry of a live job, so
 * the caller can surface the message and refetch.
 */
export async function jobAction(
  jobId: string,
  action: "cancel" | "retry",
): Promise<{ id: string; status: string }> {
  const path = `/api/admin/jobs/${encodeURIComponent(jobId)}/${action}`;
  const res = await authFetch(path, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`POST ${path} failed: ${detail}`);
  }
  return (await res.json()) as { id: string; status: string };
}

// ---------------------------------------------------------------------------
// Routines (eidan.routines) — the operator's recurring scheduled prompts and
// each one's recent fire history (eidan.routine_runs). The amygdala proactive
// loop rides on this substrate, so the pane doubles as "is scheduled agent work
// actually firing?" observability.
// ---------------------------------------------------------------------------

export type RoutineRunStatus = "started" | "delivered" | "failed" | string;

export interface RoutineRun {
  /** The local window key the routine fired for, e.g. "2026-06-15T08:00". */
  fired_for: string;
  status: RoutineRunStatus;
  detail: string | null;
  created_at: string;
}

export interface RoutineInfo {
  id: string;
  name: string;
  /** "HH:MM" (daily) or "<days> HH:MM" (e.g. "mon,wed,fri 08:00"), owner tz. */
  schedule: string;
  prompt: string;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  /** Up to the 5 most recent fires, newest first. */
  recent_runs: RoutineRun[];
}

export async function listAdminRoutines(): Promise<RoutineInfo[]> {
  const res = await authFetch("/api/admin/routines", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/admin/routines returned ${res.status}`);
  }
  const body = (await res.json()) as { routines: RoutineInfo[] };
  return body.routines;
}

// ---------------------------------------------------------------------------
// Agents (eidan.agents) — user-defined agents (persona + their own provider)
// bound to composable triggers (schedule | sensor | webhook). Epic #346. Slice 1
// ships the schedule trigger; every fire records a row in eidan.agent_runs with
// the conversation it produced.
// ---------------------------------------------------------------------------

export interface AgentTrigger {
  id: string;
  type: "schedule" | "sensor" | "webhook" | string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface AgentRunInfo {
  fire_key: string;
  status: "started" | "delivered" | "failed" | string;
  conversation_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  persona: string;
  provider: string | null;
  model: string | null;
  target_node: string | null;
  enabled: boolean;
  created_at: string;
  triggers: AgentTrigger[];
  recent_runs: AgentRunInfo[];
}

export interface OpenRouterModel {
  id: string;
  name: string;
  /** Per-token prompt price as a decimal string (OpenRouter); "0" for free. null if unknown. */
  prompt: string | null;
  completion: string | null;
}

export async function listOpenRouterModels(): Promise<OpenRouterModel[]> {
  const res = await authFetch("/api/openrouter/models", { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /api/openrouter/models returned ${res.status}`);
  const body = (await res.json()) as { models: OpenRouterModel[] };
  return body.models;
}

export async function listAgents(): Promise<AgentInfo[]> {
  const res = await authFetch("/api/admin/agents", { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /api/admin/agents returned ${res.status}`);
  const body = (await res.json()) as { agents: AgentInfo[] };
  return body.agents;
}

export interface CreateAgentInput {
  name: string;
  persona: string;
  provider?: string;
  model?: string;
  target_node?: string;
  schedule?: string;
}

async function jsonOrThrow(res: Response, what: string): Promise<unknown> {
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const b = (await res.json()) as { detail?: string };
      if (b.detail) detail = b.detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(`${what} failed: ${detail}`);
  }
  return res.json();
}

// A trimmed JSON-schema shape — enough to render a param form (object with typed/enumerated props).
export interface ToolParamSchema {
  type?: string;
  description?: string;
  enum?: Array<string | number | boolean>;
  properties?: Record<string, ToolParamSchema>;
  required?: string[];
  items?: ToolParamSchema;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  plugin: string | null;
  inputSchema: ToolParamSchema | null;
}

// The engine's live tool registry (GET /api/commands on the AG-UI host, reached through the proxy).
// Powers the @-mention picker in the persona editor — an author references a tool by name instead of
// hand-writing its call syntax; the runtime already hands the model each tool's full definition.
export async function listAgentTools(): Promise<ToolCatalogEntry[]> {
  const res = await authFetch("/api/commands", { headers: { Accept: "application/json" } });
  const body = (await jsonOrThrow(res, "GET /api/commands")) as {
    commands?: Array<{ name?: string; description?: string; plugin?: string | null; input_schema?: ToolParamSchema | null }>;
  };
  return (body.commands ?? [])
    .filter((c): c is { name: string; description?: string; plugin?: string | null; input_schema?: ToolParamSchema | null } =>
      typeof c.name === "string" && c.name.length > 0,
    )
    .map((c) => ({ name: c.name, description: c.description ?? "", plugin: c.plugin ?? null, inputSchema: c.input_schema ?? null }))
    .sort((a, b) => (a.plugin ?? "~").localeCompare(b.plugin ?? "~") || a.name.localeCompare(b.name));
}

export async function createAgent(input: CreateAgentInput): Promise<{ id: string }> {
  const res = await authFetch("/api/admin/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  return (await jsonOrThrow(res, "POST /api/admin/agents")) as { id: string };
}

export async function updateAgent(
  id: string,
  patch: { enabled?: boolean; name?: string; persona?: string; provider?: string | null; model?: string | null; target_node?: string | null },
): Promise<void> {
  const res = await authFetch(`/api/admin/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(res, `PATCH /api/admin/agents/${id}`);
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/agents/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Accept: "application/json" } });
  await jsonOrThrow(res, `DELETE /api/admin/agents/${id}`);
}

// Manual "run now" (test): fire the agent immediately and get back the conversation it created (the
// turn runs detached on the engine). Reaches the engine via the catch-all proxy (not a Next route).
export async function runAgentNow(id: string): Promise<{ conversation_id: string }> {
  const res = await authFetch(`/api/agents/${encodeURIComponent(id)}/run`, { method: "POST", headers: { Accept: "application/json" } });
  const body = (await jsonOrThrow(res, `POST /api/agents/${id}/run`)) as { conversation_id?: string };
  if (!body.conversation_id) throw new Error("run started but no conversation id returned");
  return { conversation_id: body.conversation_id };
}

export async function addAgentSchedule(id: string, schedule: string): Promise<void> {
  const res = await authFetch(`/api/admin/agents/${encodeURIComponent(id)}/triggers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ schedule }),
  });
  await jsonOrThrow(res, `POST /api/admin/agents/${id}/triggers`);
}

export async function removeAgentTrigger(id: string, triggerId: string): Promise<void> {
  const res = await authFetch(
    `/api/admin/agents/${encodeURIComponent(id)}/triggers?trigger_id=${encodeURIComponent(triggerId)}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );
  await jsonOrThrow(res, `DELETE /api/admin/agents/${id}/triggers`);
}

// ---------------------------------------------------------------------------
// Activity dashboard summary (#core admin) — aggregates over eidan.jobs +
// eidan.node_events. Plugin loop stats are fetched separately (see panels).
// ---------------------------------------------------------------------------

export type SummaryWindow = "1h" | "24h" | "7d";

export interface ActivitySummary {
  window: SummaryWindow;
  jobs_by_status: Record<string, number>;
  jobs_by_kind: Record<string, number>;
  events_by_bucket: { ts: string; turns: number; errors: number }[];
  turn_totals: { complete: number; error: number; cost_usd: number };
}

export async function getActivitySummary(
  window: SummaryWindow = "24h",
): Promise<ActivitySummary> {
  const path = `/api/admin/summary?window=${window}`;
  const res = await authFetch(path, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} returned ${res.status}`);
  }
  return (await res.json()) as ActivitySummary;
}

// ---------------------------------------------------------------------------
// Generic plugin admin panels (#284 discovery). Core lists mounted plugin
// route prefixes; the UI probes each for the conventional cursors/summary
// sub-routes. No bundle is named here — any plugin exposing the shape below
// is rendered the same way.
// ---------------------------------------------------------------------------

export interface PanelRef {
  plugin: string;
  prefix: string;
}

export async function listAdminPanels(): Promise<PanelRef[]> {
  const res = await authFetch("/api/admin/panels", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/admin/panels returned ${res.status}`);
  }
  const body = (await res.json()) as { panels: PanelRef[] };
  return body.panels;
}

/** One row in a plugin's cursor panel — the loop state of a managed item. */
export interface CursorItem {
  id: string;
  title: string;
  url: string | null;
  status: string;
  paused: boolean;
  node_id: string | null;
  detail: Record<string, unknown>;
  /** State-appropriate verbs the UI renders as buttons (e.g. ["pause"]). */
  actions: string[];
}

export interface CursorPanel {
  provider: string;
  label: string;
  kind: string;
  cursors: CursorItem[];
}

export interface ProviderSummary {
  provider: string;
  label: string;
  stats: { label: string; value: number }[];
  by_status: Record<string, number>;
}

/**
 * Probe one plugin prefix for its cursor panel. Returns null when the
 * plugin doesn't implement the convention (404) so callers can skip it —
 * a missing panel is not an error.
 */
export async function getPanelCursors(
  prefix: string,
): Promise<CursorPanel | null> {
  const res = await authFetch(`${prefix}/cursors`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${prefix}/cursors returned ${res.status}`);
  }
  return (await res.json()) as CursorPanel;
}

export async function getPanelSummary(
  prefix: string,
): Promise<ProviderSummary | null> {
  const res = await authFetch(`${prefix}/summary`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${prefix}/summary returned ${res.status}`);
  }
  return (await res.json()) as ProviderSummary;
}

/** Run a cursor action (pause/resume/…) on a plugin-managed cursor. */
export async function cursorAction(
  prefix: string,
  cursorId: string,
  action: string,
): Promise<void> {
  const path = `${prefix}/cursors/${encodeURIComponent(cursorId)}/${encodeURIComponent(action)}`;
  const res = await authFetch(path, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`POST ${path} returned ${res.status}`);
  }
}
