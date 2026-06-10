// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/**
 * Wire shape of ``GET /api/me/secrets`` (`docs/031` Phase 2): the caller's
 * connections catalogue — every ``user_provided`` vault key a loaded plugin
 * declares, each marked configured/not + its expiry. **Values are never
 * returned** — the API is write-only for the secret itself.
 */
export interface Connection {
  key: string;
  description: string;
  configured: boolean;
  expires_at: string | null;
}

interface ConnectionsResponse {
  connections: Connection[];
}

export async function fetchConnections(): Promise<Connection[]> {
  const res = await authFetch("/api/me/secrets", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/me/secrets returned ${res.status}`);
  }
  const body = (await res.json()) as ConnectionsResponse;
  return body.connections;
}

export async function setSecret(
  key: string,
  value: string,
  ttlSeconds: number | null = null,
): Promise<void> {
  const res = await authFetch(`/api/me/secrets/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { Accept: "application/json" },
    body: JSON.stringify({ value, ttl_seconds: ttlSeconds }),
  });
  if (!res.ok) {
    throw new Error(`PUT /api/me/secrets returned ${res.status}`);
  }
}

export async function deleteSecret(key: string): Promise<void> {
  const res = await authFetch(`/api/me/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`DELETE /api/me/secrets returned ${res.status}`);
  }
}
