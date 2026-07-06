// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/charles/ventures/boards — the boards within a venture (many per venture). Surface B
// (Next-reads-Postgres), owner-scoped, over plugin_ventures.venture_boards.
//   GET    ?venture=<id>          → { boards }   (ensures a default board + backfills loose items)
//   POST   { venture_id, name }   → { ok, board }
//   PUT    { id, name }            → { ok, board } (rename)
//   DELETE ?id=<id>               → { ok }       (archive the board AND its items)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface BoardRow {
  id: string;
  name: string;
  position: number;
  status: string;
}
const COLS = "id, name, position, status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const ventureId = req.nextUrl.searchParams.get("venture")?.trim() ?? "";
  if (!ventureId) return Response.json({ boards: [] });

  const result = await withUser(sess.userId, async (c) => {
    const owns = await c.query(
      `select 1 from plugin_ventures.ventures where id = $1 and user_id = $2 and status = 'active'`,
      [ventureId, sess.userId],
    );
    if (owns.rowCount === 0) return null;

    let boards = (await c.query(
      `select ${COLS} from plugin_ventures.venture_boards
        where user_id = $1 and venture_id = $2 and status = 'active'
        order by position, created_at`,
      [sess.userId, ventureId],
    )).rows as BoardRow[];

    // Ensure a venture always has at least one board (the default), so the UI never shows an empty
    // board switcher and agent-created items have somewhere to land.
    if (boards.length === 0) {
      const ins = await c.query(
        `insert into plugin_ventures.venture_boards (venture_id, user_id, name, position)
         values ($1, $2, 'Board', 0) returning ${COLS}`,
        [ventureId, sess.userId],
      );
      boards = ins.rows as BoardRow[];
    }

    // Lazily adopt any loose items (board_id null — e.g. created by the venture_item_add agent tool)
    // onto the first board, so they stay visible on the kanban.
    const firstBoard = boards[0];
    if (firstBoard) {
      await c.query(
        `update plugin_ventures.venture_items set board_id = $3, updated_at = now()
          where user_id = $1 and venture_id = $2 and board_id is null and status <> 'archived'`,
        [sess.userId, ventureId, firstBoard.id],
      );
    }
    return boards;
  });

  if (!result) return Response.json({ error: "no such venture" }, { status: 404 });
  return Response.json({ boards: result });
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
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (!ventureId) return Response.json({ error: "venture_id is required" }, { status: 400 });
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const board = await withUser(sess.userId, async (c) => {
    // INSERT…SELECT guards venture ownership and appends after the venture's current boards.
    const r = await c.query(
      `insert into plugin_ventures.venture_boards (venture_id, user_id, name, position)
       select v.id, $1, $3,
              coalesce((select max(position) + 1 from plugin_ventures.venture_boards
                         where user_id = $1 and venture_id = $2 and status = 'active'), 0)
         from plugin_ventures.ventures v
        where v.id = $2 and v.user_id = $1 and v.status = 'active'
      returning ${COLS}`,
      [sess.userId, ventureId, name],
    );
    return r.rows[0] as BoardRow | undefined;
  });
  if (!board) return Response.json({ error: "no such venture" }, { status: 404 });
  return Response.json({ ok: true, board });
}

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
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const board = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_ventures.venture_boards set name = $3, updated_at = now()
        where id = $1 and user_id = $2 and status = 'active'
      returning ${COLS}`,
      [id, sess.userId, name],
    );
    return r.rows[0] as BoardRow | undefined;
  });
  if (!board) return Response.json({ error: "no such board" }, { status: 404 });
  return Response.json({ ok: true, board });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const ok = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_ventures.venture_boards set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    // Archive the board's items too, so they don't linger as orphans on a dead board.
    await c.query(
      `update plugin_ventures.venture_items set status = 'archived', updated_at = now()
        where board_id = $1 and user_id = $2 and status <> 'archived'`,
      [id, sess.userId],
    );
    return true;
  });
  if (!ok) return Response.json({ error: "no such board" }, { status: 404 });
  return Response.json({ ok: true });
}
