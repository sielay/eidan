// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/boards/cards/refs — typed references on a card (link a card to an asset / venture / job /
// agent / url / …). Surface B, owner-scoped.
//   GET    ?card=<id>                                  → { refs }
//   POST   { card_id, ref_kind, ref_id?, ref_label? }  → { ok, ref }
//   DELETE ?id=<id>                                    → { ok }
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface RefRow { id: string; card_id: string; ref_kind: string; ref_id: string | null; ref_label: string | null }
const COLS = "id, card_id, ref_kind, ref_id, ref_label";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const cardId = req.nextUrl.searchParams.get("card")?.trim() ?? "";
  if (!cardId) return Response.json({ refs: [] });
  const refs = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select ${COLS} from plugin_boards.card_refs where user_id = $1 and card_id = $2 order by created_at`,
      [sess.userId, cardId],
    );
    return r.rows as RefRow[];
  });
  return Response.json({ refs });
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const cardId = typeof body["card_id"] === "string" ? body["card_id"].trim() : "";
  const refKind = typeof body["ref_kind"] === "string" ? body["ref_kind"].trim() : "";
  const refId = typeof body["ref_id"] === "string" && body["ref_id"].trim() ? body["ref_id"].trim() : null;
  const refLabel = typeof body["ref_label"] === "string" && body["ref_label"].trim() ? body["ref_label"].trim() : null;
  if (!cardId) return Response.json({ error: "card_id is required" }, { status: 400 });
  if (!refKind) return Response.json({ error: "ref_kind is required" }, { status: 400 });

  const ref = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_boards.card_refs (card_id, user_id, ref_kind, ref_id, ref_label)
       select k.id, $1, $3, $4, $5 from plugin_boards.cards k where k.id = $2 and k.user_id = $1
       returning ${COLS}`,
      [sess.userId, cardId, refKind, refId, refLabel],
    );
    const row = r.rows[0] as RefRow | undefined;
    if (row) await c.query(`insert into plugin_boards.card_events (card_id, user_id, kind, body) values ($1, $2, 'ref', $3)`, [cardId, sess.userId, `linked ${refKind}${refLabel ? `: ${refLabel}` : ""}`]);
    return row;
  });
  if (!ref) return Response.json({ error: "no such card" }, { status: 404 });
  return Response.json({ ok: true, ref });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const ok = await withUser(sess.userId, async (c) => {
    const r = await c.query(`delete from plugin_boards.card_refs where id = $1 and user_id = $2`, [id, sess.userId]);
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) return Response.json({ error: "no such reference" }, { status: 404 });
  return Response.json({ ok: true });
}
