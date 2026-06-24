// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/boards/cards/events — a card's activity log (comments + status/link events). Surface B.
//   GET  ?card=<id>          → { events }   (oldest first)
//   POST { card_id, body }   → { ok, event }   (adds a comment)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface EventRow { id: string; card_id: string; kind: string; body: string | null; created_at: string }
const COLS = "id, card_id, kind, body, created_at";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const cardId = req.nextUrl.searchParams.get("card")?.trim() ?? "";
  if (!cardId) return Response.json({ events: [] });
  const events = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select ${COLS} from plugin_boards.card_events where user_id = $1 and card_id = $2 order by created_at`,
      [sess.userId, cardId],
    );
    return r.rows as EventRow[];
  });
  return Response.json({ events });
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const cardId = typeof body["card_id"] === "string" ? body["card_id"].trim() : "";
  const text = typeof body["body"] === "string" ? body["body"].trim() : "";
  if (!cardId) return Response.json({ error: "card_id is required" }, { status: 400 });
  if (!text) return Response.json({ error: "body is required" }, { status: 400 });

  const event = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_boards.card_events (card_id, user_id, kind, body)
       select k.id, $1, 'comment', $3 from plugin_boards.cards k where k.id = $2 and k.user_id = $1
       returning ${COLS}`,
      [sess.userId, cardId, text],
    );
    return r.rows[0] as EventRow | undefined;
  });
  if (!event) return Response.json({ error: "no such card" }, { status: 404 });
  return Response.json({ ok: true, event });
}
