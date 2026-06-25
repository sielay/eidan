// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/charles/ventures/create — venture lifecycle (deterministic UI writes over
// plugin_ventures.ventures, owner-scoped).
//   POST   { name, kind?, legal_type?, parent_id? } → create (mirrors the ventures_create agent tool)
//   DELETE ?id=<id>                                 → archive (soft-remove; mirrors venture_update
//                                                      status='archived'). Refuses if the venture has
//                                                      active children; cascade-archives its boards /
//                                                      items / resources so nothing is left orphaned.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = ["org", "venture", "project", "employment"];
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

// PUT { id, parent_id } → reparent a venture (move it under another venture, or to top level with
// parent_id null). Cycle-guarded: the new parent may not be the venture itself or any descendant.
export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const id = typeof body["id"] === "string" ? body["id"].trim() : "";
  const parentId = typeof body["parent_id"] === "string" && body["parent_id"].trim() ? body["parent_id"].trim() : null;
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  if (parentId === id) return Response.json({ error: "a venture can't be its own parent" }, { status: 400 });

  const outcome = await withUser(sess.userId, async (c) => {
    const owns = await c.query(
      `select 1 from plugin_ventures.ventures where id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    if (owns.rowCount === 0) return "not_found";

    if (parentId) {
      const okParent = await c.query(
        `select 1 from plugin_ventures.ventures where id = $1 and user_id = $2 and status = 'active'`,
        [parentId, sess.userId],
      );
      if (okParent.rowCount === 0) return "bad_parent";
      // Cycle guard: parentId must not be inside id's own subtree.
      const cycle = await c.query(
        `with recursive sub as (
           select id from plugin_ventures.ventures where id = $1 and user_id = $2
           union all
           select v.id from plugin_ventures.ventures v join sub on v.parent_id = sub.id where v.user_id = $2
         )
         select 1 from sub where id = $3`,
        [id, sess.userId, parentId],
      );
      if ((cycle.rowCount ?? 0) > 0) return "cycle";
    }

    await c.query(
      `update plugin_ventures.ventures set parent_id = $3, updated_at = now()
        where id = $1 and user_id = $2`,
      [id, sess.userId, parentId],
    );
    return "ok";
  });

  if (outcome === "not_found") return Response.json({ error: "no such venture" }, { status: 404 });
  if (outcome === "bad_parent") return Response.json({ error: "no such parent venture" }, { status: 400 });
  if (outcome === "cycle") return Response.json({ error: "can't move a venture under itself or its own child" }, { status: 409 });
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const outcome = await withUser(sess.userId, async (c) => {
    const owns = await c.query(
      `select 1 from plugin_ventures.ventures where id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    if (owns.rowCount === 0) return "not_found";

    // Refuse if there are active nested ventures — the operator should retire or move those first,
    // so we never silently strand a subtree.
    const kids = await c.query(
      `select count(*)::int as n from plugin_ventures.ventures
        where parent_id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    if (((kids.rows[0] as { n: number }).n) > 0) return "has_children";

    // Cascade-archive everything the venture owns, then the venture itself.
    await c.query(
      `update plugin_ventures.venture_items set status = 'archived', updated_at = now()
        where venture_id = $1 and user_id = $2 and status <> 'archived'`,
      [id, sess.userId],
    );
    await c.query(
      `update plugin_ventures.venture_boards set status = 'archived', updated_at = now()
        where venture_id = $1 and user_id = $2 and status <> 'archived'`,
      [id, sess.userId],
    );
    await c.query(
      `update plugin_ventures.venture_resources set status = 'archived', updated_at = now()
        where venture_id = $1 and user_id = $2 and status <> 'archived'`,
      [id, sess.userId],
    );
    await c.query(
      `update plugin_ventures.ventures set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2`,
      [id, sess.userId],
    );
    return "ok";
  });

  if (outcome === "not_found") return Response.json({ error: "no such venture" }, { status: 404 });
  if (outcome === "has_children") {
    return Response.json({ error: "this venture has nested ventures — delete or move those first" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
