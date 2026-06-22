// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/charles/ventures/create — create a venture (mirrors the `ventures_create` agent tool /
// store.createVenture, but as the deterministic UI write behind the "Add venture" flow). Inserts a
// top-level org/venture/project (parent_id null) into plugin_ventures.ventures, owner-scoped.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = ["org", "venture", "project"];
const LEGAL_TYPES = ["ltd", "sole_trader", "holding"];

// Same slug rule as store.ts: lowercase, non-alphanumerics → hyphens, trim, ≤60, fallback.
function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 60) || "venture";
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const kind = typeof body["kind"] === "string" && body["kind"] ? body["kind"] : "venture";
  const legalType = typeof body["legal_type"] === "string" && body["legal_type"] ? body["legal_type"] : null;
  const parentId = typeof body["parent_id"] === "string" && body["parent_id"].trim() ? body["parent_id"].trim() : null;

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!KINDS.includes(kind)) return Response.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  if (legalType !== null && !LEGAL_TYPES.includes(legalType)) {
    return Response.json({ error: `legal_type must be one of ${LEGAL_TYPES.join(", ")}` }, { status: 400 });
  }

  try {
    const venture = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `insert into plugin_ventures.ventures (user_id, parent_id, name, slug, kind, legal_type)
         values ($1, $2, $3, $4, $5, $6)
         returning id, name, kind, legal_type, status`,
        [sess.userId, parentId, name, slugify(name), kind, legalType],
      );
      return r.rows[0] as { id: string; name: string; kind: string; legal_type: string | null; status: string };
    });
    return Response.json({ ok: true, venture });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Per-owner active-slug unique index (uq_ventures_user_slug).
    if (/uq_ventures_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "a venture with that name already exists" }, { status: 409 });
    }
    return Response.json({ error: "could not create venture" }, { status: 500 });
  }
}
