// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/charles/ventures/decisions — the venture decision log over the @eidandev/decisions store
// (eidan.kv, namespace='decisions'). GET ?venture=<slug|id> lists a venture's decisions; PUT edits one
// (title/decision/rationale/status/tags/venture); DELETE ?id= removes one. Decisions are authored by
// the agent (decision_record); this lets the operator correct them in the UI. Self-contained (no import
// from the plugin src/) — the store's PK is (namespace,id), a plain upsert with no version history.
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["accepted", "proposed", "superseded"];

interface DecisionRow {
  doc: {
    id?: string;
    title?: string;
    decision?: string;
    rationale?: string;
    status?: string;
    tags?: unknown;
    venture?: string | null;
    updatedAt?: string;
    createdAt?: string;
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const venture = (req.nextUrl.searchParams.get("venture") || "").trim();
  if (!venture) return Response.json({ decisions: [] });

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select doc from eidan.kv
         where namespace = 'decisions' and (doc->>'venture') = $1
         order by case doc->>'status'
                    when 'accepted' then 0 when 'proposed' then 1 else 2 end,
                  (doc->>'updatedAt') desc nulls last`,
      [venture],
    );
    return r.rows as DecisionRow[];
  });

  const decisions = rows.map(({ doc: d }) => ({
    id: d.id ?? null,
    title: d.title ?? "(untitled)",
    decision: d.decision ?? "",
    rationale: d.rationale ?? "",
    status: d.status ?? "accepted",
    tags: Array.isArray(d.tags) ? (d.tags as unknown[]).map(String) : [],
    venture: d.venture ?? null,
    updatedAt: d.updatedAt ?? d.createdAt ?? null,
  }));

  return Response.json({ decisions });
}

// Edit a decision in place. Only the named fields change; bumps the doc version + updatedAt so the
// agent's decision_search sees the corrected copy next time.
export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const id = typeof body["id"] === "string" ? body["id"].trim() : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const updated = await withUser(sess.userId, async (c) => {
    const cur = await c.query(`select doc from eidan.kv where namespace = 'decisions' and id = $1`, [id]);
    if (!cur.rows.length) return null;
    const doc = ((cur.rows[0] as { doc: Record<string, unknown> }).doc) ?? {};
    for (const k of ["title", "decision", "rationale"]) if (typeof body[k] === "string") doc[k] = (body[k] as string);
    if (typeof body["status"] === "string" && STATUSES.includes(body["status"] as string)) doc["status"] = body["status"];
    if (Array.isArray(body["tags"])) doc["tags"] = (body["tags"] as unknown[]).map((x) => String(x).trim()).filter(Boolean);
    if ("venture" in body) doc["venture"] = typeof body["venture"] === "string" ? ((body["venture"] as string).trim() || null) : null;
    const version = randomUUID();
    doc["version"] = version;
    doc["updatedAt"] = new Date().toISOString();
    await c.query(`update eidan.kv set version = $2, doc = $3::jsonb, updated_at = now() where namespace = 'decisions' and id = $1`, [id, version, JSON.stringify(doc)]);
    return doc;
  });
  if (!updated) return Response.json({ error: "no such decision" }, { status: 404 });
  return Response.json({ ok: true, decision: updated });
}

// Delete a decision (the operator's own log — a hard delete; to keep an audit trail instead, set
// status to "superseded" via PUT).
export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = (req.nextUrl.searchParams.get("id") || "").trim();
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const ok = await withUser(sess.userId, async (c) => {
    const r = await c.query(`delete from eidan.kv where namespace = 'decisions' and id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
  return ok ? Response.json({ ok: true }) : Response.json({ error: "no such decision" }, { status: 404 });
}
