// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/boards/cards — cards on a board. Surface B (Next-reads-Postgres), owner-scoped.
//   GET    ?board=<id>                       → { cards }   (each with ref_count)
//   POST   { board_id, title, body? }        → { ok, card }
//   PUT    { id, title?, body?, status? }     → { ok, card }   (status change logs an event)
//   DELETE ?id=<id>                          → { ok }       (archive)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface CardRow { id: string; board_id: string; title: string; body: string | null; status: string; position: number; metadata?: Record<string, unknown>; ref_count?: number }
const STATUSES = ["open", "doing", "done", "archived"];
const COLS = "id, board_id, title, body, status, position, metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const boardId = req.nextUrl.searchParams.get("board")?.trim() ?? "";
  if (!boardId) return Response.json({ cards: [] });

  const cards = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select ${COLS.split(", ").map((x) => "k." + x).join(", ")},
              (select count(*)::int from plugin_boards.card_refs r where r.card_id = k.id) as ref_count
         from plugin_boards.cards k
        where k.user_id = $1 and k.board_id = $2 and k.status <> 'archived'
        order by k.position, k.created_at desc`,
      [sess.userId, boardId],
    );
    return r.rows as CardRow[];
  });
  return Response.json({ cards });
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const boardId = typeof body["board_id"] === "string" ? body["board_id"].trim() : "";
  const title = typeof body["title"] === "string" ? body["title"].trim() : "";
  const cardBody = typeof body["body"] === "string" && body["body"].trim() ? body["body"].trim() : null;
  if (!boardId) return Response.json({ error: "board_id is required" }, { status: 400 });
  if (!title) return Response.json({ error: "title is required" }, { status: 400 });

  const card = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_boards.cards (board_id, user_id, title, body)
       select b.id, $1, $3, $4 from plugin_boards.boards b
        where b.id = $2 and b.user_id = $1 and b.status = 'active'
       returning ${COLS}`,
      [sess.userId, boardId, title, cardBody],
    );
    return r.rows[0] as CardRow | undefined;
  });
  if (!card) return Response.json({ error: "no such board" }, { status: 404 });
  return Response.json({ ok: true, card });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const id = typeof body["id"] === "string" ? body["id"].trim() : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const sets: string[] = [];
  const vals: unknown[] = [id, sess.userId];
  let statusChange: string | null = null;
  if (typeof body["status"] === "string") {
    if (!STATUSES.includes(body["status"])) return Response.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
    statusChange = body["status"];
    vals.push(body["status"]); sets.push(`status = $${vals.length}`);
  }
  if (typeof body["title"] === "string" && body["title"].trim()) { vals.push(body["title"].trim()); sets.push(`title = $${vals.length}`); }
  if (typeof body["body"] === "string") { vals.push(body["body"].trim() || null); sets.push(`body = $${vals.length}`); }
  if (Array.isArray(body["labels"])) {
    // Store labels under metadata.labels (deduped, trimmed strings).
    const labels = [...new Set((body["labels"] as unknown[]).map((l) => String(l).trim()).filter(Boolean))];
    vals.push(JSON.stringify(labels));
    sets.push(`metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{labels}', $${vals.length}::jsonb, true)`);
  }
  if (!sets.length) return Response.json({ error: "nothing to update" }, { status: 400 });

  const card = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_boards.cards set ${sets.join(", ")}, updated_at = now()
        where id = $1 and user_id = $2 returning ${COLS}`,
      vals,
    );
    const row = r.rows[0] as CardRow | undefined;
    if (row && statusChange) {
      await c.query(`insert into plugin_boards.card_events (card_id, user_id, kind, body) values ($1, $2, 'status', $3)`, [id, sess.userId, statusChange]);
    }
    return row;
  });
  if (!card) return Response.json({ error: "no such card" }, { status: 404 });
  return Response.json({ ok: true, card });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const ok = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_boards.cards set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status <> 'archived'`,
      [id, sess.userId],
    );
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) return Response.json({ error: "no such card" }, { status: 404 });
  return Response.json({ ok: true });
}
