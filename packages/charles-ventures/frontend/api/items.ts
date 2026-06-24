// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/charles/ventures/items — the deterministic data route for the venture board (Surface B:
// Next-reads-Postgres, the same pattern as the sibling ventures route). Reads/writes the bundle's own
// plugin_ventures.venture_items, owner-scoped — the web mirror of the venture_item_add / venture_items
// / venture_set_item_status agent tools, so the operator can run the board from chat or the UI.
//   GET    ?board=<id> | ?venture=<id>        → { items }            (live items, newest first)
//   POST   { board_id, title, kind?, body? }  → { ok, item }        (add a card to a board)
//   PUT    { id, status?, title?, body? }       → { ok, item }        (edit / move a card)
//   DELETE ?id=<id>                            → { ok }              (archive a card)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface ItemRow {
  id: string;
  venture_id: string;
  kind: string;
  title: string;
  body: string | null;
  status: string;
}

const ITEM_KINDS = ["task", "idea", "note"];
// The live board lanes plus the archived tombstone (the build progression: open → doing → done).
const ITEM_STATUSES = ["open", "doing", "done", "archived"];
const COLS = "id, venture_id, kind, title, body, status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const boardId = req.nextUrl.searchParams.get("board")?.trim() ?? "";
  const ventureId = req.nextUrl.searchParams.get("venture")?.trim() ?? "";
  if (!boardId && !ventureId) return Response.json({ items: [] });

  const items = await withUser(sess.userId, async (c) => {
    // Prefer board scope (the multi-board kanban); fall back to whole-venture (back-compat).
    const r = boardId
      ? await c.query(
          `select ${COLS} from plugin_ventures.venture_items
            where user_id = $1 and board_id = $2 and status <> 'archived'
            order by created_at desc`,
          [sess.userId, boardId],
        )
      : await c.query(
          `select ${COLS} from plugin_ventures.venture_items
            where user_id = $1 and venture_id = $2 and status <> 'archived'
            order by created_at desc`,
          [sess.userId, ventureId],
        );
    return r.rows as ItemRow[];
  });
  return Response.json({ items });
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

  const boardId = typeof body["board_id"] === "string" ? body["board_id"].trim() : "";
  const title = typeof body["title"] === "string" ? body["title"].trim() : "";
  const kind = typeof body["kind"] === "string" && ITEM_KINDS.includes(body["kind"]) ? (body["kind"] as string) : "task";
  const itemBody = typeof body["body"] === "string" && body["body"].trim() ? body["body"].trim() : null;
  if (!boardId) return Response.json({ error: "board_id is required" }, { status: 400 });
  if (!title) return Response.json({ error: "title is required" }, { status: 400 });

  // The INSERT…SELECT guards board ownership and derives the venture from the board in one statement —
  // a foreign or archived board yields zero rows → 404.
  const item = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_ventures.venture_items (venture_id, user_id, board_id, kind, title, body)
       select b.venture_id, $1, b.id, $3, $4, $5
         from plugin_ventures.venture_boards b
        where b.id = $2 and b.user_id = $1 and b.status = 'active'
      returning ${COLS}`,
      [sess.userId, boardId, kind, title, itemBody],
    );
    return r.rows[0] as ItemRow | undefined;
  });
  if (!item) return Response.json({ error: "no such board" }, { status: 404 });
  return Response.json({ ok: true, item });
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
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  // Build a partial update from whichever fields are present; a status must be a valid lane.
  const sets: string[] = [];
  const vals: unknown[] = [sess.userId, id];
  if (typeof body["status"] === "string") {
    if (!ITEM_STATUSES.includes(body["status"])) {
      return Response.json({ error: `status must be one of ${ITEM_STATUSES.join(", ")}` }, { status: 400 });
    }
    vals.push(body["status"]);
    sets.push(`status = $${vals.length}`);
  }
  if (typeof body["title"] === "string" && body["title"].trim()) {
    vals.push(body["title"].trim());
    sets.push(`title = $${vals.length}`);
  }
  if (typeof body["body"] === "string") {
    vals.push(body["body"].trim() || null);
    sets.push(`body = $${vals.length}`);
  }
  if (!sets.length) return Response.json({ error: "nothing to update" }, { status: 400 });

  const item = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_ventures.venture_items
          set ${sets.join(", ")}, updated_at = now()
        where id = $2 and user_id = $1
      returning ${COLS}`,
      vals,
    );
    return r.rows[0] as ItemRow | undefined;
  });
  if (!item) return Response.json({ error: "no such item" }, { status: 404 });
  return Response.json({ ok: true, item });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const ok = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_ventures.venture_items
          set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status <> 'archived'`,
      [id, sess.userId],
    );
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) return Response.json({ error: "no such item" }, { status: 404 });
  return Response.json({ ok: true });
}
