// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

// One @-mention candidate (file/folder/agent/venture/asset). The editor inserts a resolvable token the
// engine expands at turn time. See apps/web/src/app/api/mentions/search/route.ts.
export interface MentionHit {
  type: "file" | "folder" | "agent" | "venture" | "asset";
  id: string;
  label: string;
  hint: string;
}

// The on-the-wire token: a markdown link with the `eidan:` scheme — readable as "label" in any markdown
// renderer, and parseable by the engine (frontend-agui) which expands it into real context for the turn.
export function mentionToken(hit: { type: string; id: string; label: string }): string {
  // Keep the label link-safe: no unescaped ] or ) breaking the markdown link.
  const label = hit.label.replace(/[[\]()]/g, " ").trim() || hit.type;
  return `[${label}](eidan:${hit.type}:${hit.id})`;
}

// Mirror of the engine-side resolver regex — used by the UI to render/measure existing mentions.
export const MENTION_RE = /\[([^\]]+)\]\(eidan:(file|folder|agent|venture|asset):([^)\s]+)\)/g;

export async function searchMentions(q: string, types?: string[]): Promise<MentionHit[]> {
  const params = new URLSearchParams({ q });
  if (types && types.length) params.set("types", types.join(","));
  const res = await authFetch(`/api/mentions/search?${params.toString()}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: MentionHit[] };
  return body.items ?? [];
}
