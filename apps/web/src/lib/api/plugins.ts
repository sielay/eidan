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

interface PluginsResponse {
  plugins: PluginSummary[];
}

export async function listPlugins(
): Promise<PluginSummary[]> {
  const res = await authFetch("/api/plugins", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/plugins returned ${res.status}`);
  }
  const body = (await res.json()) as PluginsResponse;
  return body.plugins;
}
