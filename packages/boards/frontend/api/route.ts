// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/boards — boards within a scope (many per scope). Surface B (Next-reads-Postgres), owner-scoped
// over plugin_boards.boards. Scope binds a board to a context via scope_kind/scope_id (e.g.
// venture/<id>); omit scope_kind for standalone/personal boards.
//   GET    ?scope_kind=&scope_id=   → { boards }
//   POST   { name, scope_kind?, scope_id? } → { ok, board }
//   PUT    { id, name }              → { ok, board }
//   DELETE ?id=<id>                 → { ok }   (archives the board AND its cards)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface BoardRow { id: string; name: string; scope_kind: string | null; scope_id: string | null; position: number; status: string }
const COLS = "id, name, scope_kind, scope_id, position, status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const sk = req.nextUrl.searchParams.get("scope_kind")?.trim() || null;
  const si = req.nextUrl.searchParams.get("scope_id")?.trim() || null;

  const boards = await withUser(sess.userId, async (c) => {
    const vals: unknown[] = [sess.userId];
    let where = "user_id = $1 and status = 'active'";
    if (sk) {
      vals.push(sk);
      where += ` and scope_kind = $${vals.length}`;
      if (si) { vals.push(si); where += ` and scope_id = $${vals.length}`; }
      else where += " and scope_id is null";
    } else {
      where += " and scope_kind is null";
    }
    const r = await c.query(`select ${COLS} from plugin_boards.boards where ${where} order by position, created_at`, vals);
    return r.rows as BoardRow[];
  });
  return Response.json({ boards });
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const sk = typeof body["scope_kind"] === "string" && body["scope_kind"].trim() ? body["scope_kind"].trim() : null;
  const si = typeof body["scope_id"] === "string" && body["scope_id"].trim() ? body["scope_id"].trim() : null;
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const board = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_boards.boards (user_id, name, scope_kind, scope_id, position)
       values ($1, $2, $3, $4,
         coalesce((select max(position) + 1 from plugin_boards.boards
                    where user_id = $1 and status = 'active'
                      and scope_kind is not distinct from $3 and scope_id is not distinct from $4), 0))
       returning ${COLS}`,
      [sess.userId, name, sk, si],
    );
    return r.rows[0] as BoardRow;
  });
  return Response.json({ ok: true, board });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const id = typeof body["id"] === "string" ? body["id"].trim() : "";
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const board = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_boards.boards set name = $3, updated_at = now()
        where id = $1 and user_id = $2 and status = 'active' returning ${COLS}`,
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
      `update plugin_boards.boards set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    await c.query(
      `update plugin_boards.cards set status = 'archived', updated_at = now()
        where board_id = $1 and user_id = $2 and status <> 'archived'`,
      [id, sess.userId],
    );
    return true;
  });
  if (!ok) return Response.json({ error: "no such board" }, { status: 404 });
  return Response.json({ ok: true });
}
