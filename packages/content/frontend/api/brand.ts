// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/content/brand — read/write a brand kit at a given SCOPE (Surface B: Next-reads-Postgres,
// owner-scoped over plugin_content.brand_kits via RLS). Scopes cascade: 'default' → 'venture:<id>'
// (inherits parent ventures) → 'venture:<id>:<channel>'. GET resolves the cascade so the editor can
// show what a scope inherits vs overrides; PUT writes only the exact scope. The agent edits the same
// kits via the brand_kit tool.
//   GET  ?scope=<scope>                         → { scope, layer, effective, chain }
//   PUT  ?scope=<scope> { voice?, styleguide?, language? } → { ok, layer }  (partial)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

// Cascade helpers are inlined (not imported) because a plugin API handler is copied standalone into the
// Next app tree, losing sibling imports — it can only import @/server/*. Mirror of packages/content/
// {src/scope.ts, frontend/cascade.ts}; keep them in sync. Pure + small.
const DEFAULT_SCOPE = "default";
interface BrandFields { voice: string | null; styleguide: string | null; language: string | null; reference_images: string[] }
interface ScopeParts { kind: "default" | "venture" | "channel"; ventureId?: string; channel?: string }

function parseScope(scope: string): ScopeParts {
  const s = (scope || "").trim();
  if (!s || s === DEFAULT_SCOPE) return { kind: "default" };
  const m = /^venture:([^:]+)(?::(.+))?$/.exec(s);
  if (!m) return { kind: "default" };
  const ventureId = m[1];
  if (!ventureId) return { kind: "default" };
  const channel = m[2];
  if (channel) return { kind: "channel", ventureId, channel };
  return { kind: "venture", ventureId };
}

function scopeChain(target: string, ancestry: readonly string[]): string[] {
  const parts = parseScope(target);
  const chain: string[] = [DEFAULT_SCOPE];
  if (parts.kind === "default") return chain;
  const line = ancestry.length ? ancestry : parts.ventureId ? [parts.ventureId] : [];
  for (const id of line) chain.push(`venture:${id}`);
  if (parts.kind === "channel" && parts.ventureId && parts.channel) chain.push(`venture:${parts.ventureId}:${parts.channel}`);
  const seen = new Set<string>();
  return chain.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

function mergeBrandLayers(layers: readonly Partial<BrandFields>[]): BrandFields {
  const out: BrandFields = { voice: null, styleguide: null, language: null, reference_images: [] };
  const refs: string[] = [];
  const ne = (v: string | null | undefined): string | null => (typeof v === "string" && v.trim() ? v : null);
  for (const layer of layers) {
    if (!layer) continue;
    const v = ne(layer.voice); if (v) out.voice = v;
    const s = ne(layer.styleguide); if (s) out.styleguide = s;
    const l = ne(layer.language); if (l) out.language = l;
    for (const r of layer.reference_images ?? []) if (r && !refs.includes(r)) refs.push(r);
  }
  out.reference_images = refs;
  return out;
}

interface BrandRow { scope: string; voice: string | null; styleguide: string | null; language: string | null; reference_images: unknown }
interface Layer { scope: string; voice: string | null; styleguide: string | null; language: string | null; reference_images: string[] }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function scopeOf(req: NextRequest): string {
  return (req.nextUrl.searchParams.get("scope") || DEFAULT_SCOPE).trim() || DEFAULT_SCOPE;
}

function toLayer(r: BrandRow): Layer {
  return {
    scope: r.scope,
    voice: r.voice,
    styleguide: r.styleguide,
    language: r.language,
    reference_images: Array.isArray(r.reference_images) ? r.reference_images.map(String) : [],
  };
}

// Walk plugin_ventures upward (root→…→venture), owner-scoped. Guarded: a slug/missing ventures plugin
// yields just [ventureId] so the cascade degrades to default → this-venture.
async function ancestry(c: import("pg").PoolClient, userId: string, ventureId: string): Promise<string[]> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(ventureId)) return [ventureId];
  try {
    const r = await c.query(
      `with recursive up as (
         select id, parent_id, 0 as depth from plugin_ventures.ventures
           where id = $2 and user_id = $1 and status = 'active'
         union all
         select v.id, v.parent_id, up.depth + 1 from plugin_ventures.ventures v
           join up on v.id = up.parent_id where v.user_id = $1 and v.status = 'active'
       ) select id from up order by depth desc`,
      [userId, ventureId],
    );
    const ids = r.rows.map((x: { id: string }) => x.id);
    return ids.length ? ids : [ventureId];
  } catch {
    return [ventureId];
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const scope = scopeOf(req);
  const parts = parseScope(scope);

  const result = await withUser(sess.userId, async (c) => {
    const line = parts.kind === "default" ? [] : await ancestry(c, sess.userId, parts.ventureId ?? "");
    const chain = scopeChain(scope, line);
    const r = await c.query(
      `select scope, voice, styleguide, language, reference_images
         from plugin_content.brand_kits where user_id = $1 and scope = any($2)`,
      [sess.userId, chain],
    );
    const byScope = new Map<string, Layer>();
    for (const row of r.rows as BrandRow[]) { const l = toLayer(row); byScope.set(l.scope, l); }
    const layers = chain.map((s) => byScope.get(s)).filter((l): l is Layer => !!l);
    const effective: BrandFields = mergeBrandLayers(layers);
    const layer = byScope.get(scope) ?? { scope, voice: null, styleguide: null, language: null, reference_images: [] };
    return { scope, layer, effective, chain };
  });
  return Response.json(result);
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const scope = scopeOf(req);
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  const sets: string[] = [];
  const vals: unknown[] = [sess.userId, scope];
  const put = (col: string, key: string): void => {
    if (typeof body[key] === "string") { vals.push((body[key] as string).trim() || null); sets.push(`${col} = $${vals.length}`); }
  };
  put("voice", "voice"); put("styleguide", "styleguide"); put("language", "language");
  if (!sets.length) return Response.json({ error: "nothing to update" }, { status: 400 });

  const layer = await withUser(sess.userId, async (c) => {
    await c.query(
      `insert into plugin_content.brand_kits (user_id, scope) values ($1, $2) on conflict (user_id, scope) do nothing`,
      [sess.userId, scope],
    );
    const r = await c.query(
      `update plugin_content.brand_kits set ${sets.join(", ")}, updated_at = now() where user_id = $1 and scope = $2
       returning scope, voice, styleguide, language, reference_images`,
      vals,
    );
    return toLayer(r.rows[0] as BrandRow);
  });
  return Response.json({ ok: true, layer });
}
