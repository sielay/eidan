// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/**
 * One row from ``GET /api/plugins`` — mirrors the backend route's
 * payload (`docs/001 §1` for manifest fields; the host renders a
 * read-only snapshot of what was loaded at startup).
 */
export interface PluginSummary {
  name: string;
  display_name: string;
  tier: "core" | "pro" | "commercial";
  version: string;
  description: string | null;
  enabled: boolean;
}

export interface NodeIdentity {
  node_id: string;
  node_type: string;
}

export interface PluginsResponse {
  node: NodeIdentity | null;
  plugins: PluginSummary[];
}

export async function listPlugins(): Promise<PluginsResponse> {
  const res = await authFetch("/api/plugins", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/plugins returned ${res.status}`);
  }
  return (await res.json()) as PluginsResponse;
}

export interface PluginAuthor {
  name: string;
  email: string | null;
}

export interface PluginDetail {
  name: string;
  display_name: string;
  tier: "core" | "pro" | "commercial";
  version: string;
  description: string | null;
  license: string | null;
  authors: PluginAuthor[];
  readme: string | null;
}

export async function getPlugin(name: string): Promise<PluginDetail> {
  const res = await authFetch(`/api/plugins/${encodeURIComponent(name)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/plugins/${name} returned ${res.status}`);
  }
  return (await res.json()) as PluginDetail;
}
