// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/charles/ventures — the deterministic data route for the Ventures screen (Surface B:
// Next-reads-Postgres, the same pattern as core's /api/knowledge). Reads/writes the bundle's own
// plugin_ventures.* schema, owner-scoped. Shipped in the bundle's frontend package because the data
// is private to the Charles bundle; the build-context assembly mounts it under apps/web.
//   GET  ?venture=<id>  → { ventures, current (incl. identity), resources }
//   POST { venture_id, kind, provider, external_ref, label? } → attach a resource
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface VentureRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  legal_type: string | null;
  status: string;
  identity: Record<string, unknown> | null;
}
// As returned to the client: the raw row plus a derived parent_name (resolved in-process from the
// owner's own venture set, so the UI can label/group the tree without a join).
interface VentureOut extends VentureRow {
  parent_name: string | null;
}
interface ResourceRow {
  id: string;
  kind: string;
  provider: string;
  external_ref: string;
  label: string | null;
  status: string;
}

const RES_KINDS = ["social_account", "mailing_list", "analytics_property"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const wanted = req.nextUrl.searchParams.get("venture");

  const payload = await withUser(sess.userId, async (c) => {
    const v = await c.query(
      `select id, parent_id, name, kind, legal_type, status, metadata->'identity' as identity
         from plugin_ventures.ventures
        where user_id = $1 and status = 'active'
        order by parent_id nulls first, created_at`,
      [sess.userId],
    );
    const rows = v.rows as VentureRow[];
    // Derive parent_name from the same owner-scoped set (rows are already parents-before-children),
    // mirroring the venture_list agent tool so the web tree reads the same as the chat surface.
    const byId = new Map(rows.map((row) => [row.id, row.name]));
    const ventures: VentureOut[] = rows.map((row) => ({
      ...row,
      parent_name: row.parent_id ? byId.get(row.parent_id) ?? null : null,
    }));
    const current = ventures.find((row) => row.id === wanted) ?? ventures[0] ?? null;

    let resources: ResourceRow[] = [];
    if (current) {
      const r = await c.query(
        `select id, kind, provider, external_ref, label, status
           from plugin_ventures.venture_resources
          where user_id = $1 and venture_id = $2 and status = 'active'
          order by created_at`,
        [sess.userId, current.id],
      );
      resources = r.rows as ResourceRow[];
    }
    return { ventures, current, resources };
  });

  return Response.json(payload);
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

  const ventureId = typeof body["venture_id"] === "string" ? body["venture_id"].trim() : "";
  const kind = typeof body["kind"] === "string" ? body["kind"] : "";
  const provider = typeof body["provider"] === "string" ? body["provider"].trim() : "";
  const externalRef = typeof body["external_ref"] === "string" ? body["external_ref"].trim() : "";
  const label = typeof body["label"] === "string" && body["label"].trim() ? body["label"].trim() : null;

  if (!ventureId) return Response.json({ error: "venture_id is required" }, { status: 400 });
  if (!RES_KINDS.includes(kind)) return Response.json({ error: `kind must be one of ${RES_KINDS.join(", ")}` }, { status: 400 });
  if (!provider) return Response.json({ error: "provider is required" }, { status: 400 });
  if (!externalRef) return Response.json({ error: "external_ref is required" }, { status: 400 });

  try {
    const resource = await withUser(sess.userId, async (c) => {
      // Guard: the venture must belong to the caller (the insert is user_id-scoped, but a clean 404
      // beats a foreign-key error leaking).
      const owns = await c.query(
        `select 1 from plugin_ventures.ventures where id = $1 and user_id = $2 and status = 'active'`,
        [ventureId, sess.userId],
      );
      if (owns.rowCount === 0) return null;
      const r = await c.query(
        `insert into plugin_ventures.venture_resources
            (venture_id, user_id, kind, provider, external_ref, label)
         values ($1, $2, $3, $4, $5, $6)
         returning id, kind, provider, external_ref, label, status`,
        [ventureId, sess.userId, kind, provider, externalRef, label],
      );
      return r.rows[0] as ResourceRow;
    });
    if (!resource) return Response.json({ error: "no such venture" }, { status: 404 });
    return Response.json({ ok: true, resource });
  } catch (err) {
    // The per-owner active unique index rejects attaching the same (provider, external_ref) twice.
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_vr_provider_ref|duplicate key/i.test(msg)) {
      return Response.json({ error: "that account is already attached to a venture" }, { status: 409 });
    }
    return Response.json({ error: "could not attach resource" }, { status: 500 });
  }
}
