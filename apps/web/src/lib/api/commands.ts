// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/**
 * One row from ``GET /api/commands`` — the host's snapshot of every
 * plugin command registered at activation time. Rendered into the
 * Cmd-K palette per `docs/014 §7` (`docs/019` runtime side).
 */
export interface CommandSummary {
  name: string;
  description: string;
  plugin: string | null;
  idempotent: boolean;
}

interface CommandsResponse {
  commands: CommandSummary[];
}

export async function listCommands(
): Promise<CommandSummary[]> {
  const res = await authFetch("/api/commands", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /api/commands returned ${res.status}`);
  }
  const body = (await res.json()) as CommandsResponse;
  return body.commands;
}
