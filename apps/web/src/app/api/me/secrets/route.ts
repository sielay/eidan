// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/me/secrets — the caller's connection catalogue (docs/031 Phase 2). Merges the
// plugin-declared catalogue of possible keys (engine state, via the secrets-api reached through the
// AG-UI panel proxy) with which keys the user has actually configured (the vault, RLS-scoped). So
// Settings → Connections renders a field for every credential a plugin asks for, marking the ones
// already set. Values are NEVER returned.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CatalogField {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}
interface CatalogSection { plugin: string; title: string; fields: CatalogField[] }

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  // Which keys the user has actually set (RLS-scoped; values never read).
  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select key, max(expires_at) as expires_at
         from eidan.secrets_vault where user_id = $1
         group by key order by key`,
      [sess.userId],
    );
    return r.rows as Array<{ key: string; expires_at: unknown }>;
  });
  const setKeys = new Map(rows.map((r) => [r.key, r.expires_at] as const));

  // The plugin-declared catalogue lives in the engine (secrets-api), reachable via the AG-UI panel
  // proxy. Best-effort: if the engine is unreachable we just surface the configured keys.
  const engine = process.env.EIDAN_ENGINE_URL;
  const auth = req.headers.get("authorization");
  let catalog: CatalogSection[] = [];
  if (engine && auth) {
    try {
      const r = await fetch(`${engine}/api/me/secrets/catalog`, {
        headers: { authorization: auth },
      });
      if (r.ok) catalog = ((await r.json()) as { catalog?: CatalogSection[] }).catalog ?? [];
    } catch {
      // engine offline → fall through to configured-only
    }
  }

  // Declared fields first (so an offered-but-unset key still renders a field), then any
  // set-but-undeclared keys (a credential whose plugin isn't loaded on this node).
  const seen = new Set<string>();
  const connections: Array<{
    key: string;
    description: string;
    configured: boolean;
    expires_at: string | null;
  }> = [];
  for (const section of catalog) {
    for (const f of section.fields) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      connections.push({
        key: f.name,
        description: f.help ?? f.label ?? f.name,
        configured: setKeys.has(f.name),
        expires_at: null,
      });
    }
  }
  for (const [key, exp] of setKeys) {
    if (seen.has(key)) continue;
    connections.push({ key, description: key, configured: true, expires_at: exp ? iso(exp) : null });
  }

  return Response.json({ connections });
}
