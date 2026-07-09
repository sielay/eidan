// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/boards/cards — cards on a board. Surface B (Next-reads-Postgres), owner-scoped.
//   GET    ?board=<id>                       → { cards }   (each with ref_count)
//   POST   { board_id, title, body? }        → { ok, card }
//   PUT    /[id] { title?, body?, status? }  → { ok, card }   (status change logs an event)
//   DELETE ?id=<id>                          → { ok }       (archive)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface CardRow { id: string; board_id: string; title: string; body: string | null; status: string; position: number; metadata?: Record<string, unknown>; due_date?: string | null; ref_count?: number; conversation_id?: string | null; parent_card_id?: string | null; channels?: string[]; publish_at?: string | null; frozen_data?: Record<string, unknown>; user_id?: string }
// Boards can define their own columns (a content board runs concept→…→published, not open/doing/done).
// 'archived' is always the soft-delete tombstone regardless of a board's lanes.
const STATUSES = ["open", "doing", "done", "concept", "assets", "copy", "distribution", "scheduled", "published", "archived"];
const CHANNELS = ["linkedin", "x", "bluesky", "threads", "newsletter", "youtube", "shorts", "blog", "pdf"];
const COLS = "id, board_id, title, body, status, position, metadata, due_date, conversation_id, parent_card_id, channels, publish_at, frozen_data, user_id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const boardId = req.nextUrl.searchParams.get("board")?.trim() ?? "";
  if (!boardId) return Response.json({ cards: [] });

  const cards = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select k.id, k.board_id, k.title, k.body, k.status, k.position, k.metadata, k.due_date,
              k.conversation_id, k.parent_card_id, k.channels, k.publish_at, k.frozen_data, k.user_id,
              (select count(*)::int from plugin_boards.card_refs r where r.card_id = k.id) as ref_count
         from plugin_boards.cards k
        where k.user_id = $1 and k.board_id = $2 and k.status <> 'archived'
        order by k.due_date is null, k.due_date asc, k.position, k.created_at desc`,
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
  const dueDate = typeof body["due_date"] === "string" && body["due_date"].trim() ? body["due_date"].trim() : null;
  const conversationId = typeof body["conversation_id"] === "string" && body["conversation_id"].trim() ? body["conversation_id"].trim() : null;
  const parentCardId = typeof body["parent_card_id"] === "string" && body["parent_card_id"].trim() ? body["parent_card_id"].trim() : null;
  const publishAt = typeof body["publish_at"] === "string" && body["publish_at"].trim() ? body["publish_at"].trim() : null;
  // frozen_data is read-only and only updated via gate-advance endpoint; reject if provided in POST.
  if (typeof body["frozen_data"] === "object" && body["frozen_data"] !== null) {
    return Response.json({ error: "frozen_data is read-only" }, { status: 400 });
  }
  let channels: string[] | null = null;
  if (Array.isArray(body["channels"])) {
    const ch = (body["channels"] as unknown[]).map((c) => String(c).trim()).filter(Boolean);
    const invalid = ch.filter((c) => !CHANNELS.includes(c));
    if (invalid.length > 0) return Response.json({ error: `invalid channels: ${invalid.join(", ")}` }, { status: 400 });
    channels = ch;
  }
  const status = typeof body["status"] === "string" && STATUSES.includes(body["status"]) ? body["status"] : null;
  if (!boardId) return Response.json({ error: "board_id is required" }, { status: 400 });
  if (!title) return Response.json({ error: "title is required" }, { status: 400 });

  const card = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_boards.cards (board_id, user_id, title, body, due_date, status, conversation_id, parent_card_id, channels, publish_at, frozen_data)
       select b.id, $1, $3, $4, $5, coalesce($6, 'open'), $7, $8, $9::jsonb, $10, null from plugin_boards.boards b
        where b.id = $2 and b.user_id = $1 and b.status = 'active'
       returning ${COLS}`,
      [sess.userId, boardId, title, cardBody, dueDate, status, conversationId, parentCardId, channels ? JSON.stringify(channels) : null, publishAt],
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
  // Extract id from URL path: /api/boards/cards/[id]
  const pathSegments = req.nextUrl.pathname.split("/");
  const id = pathSegments[pathSegments.length - 1]?.trim() ?? "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  // frozen_data is read-only and only updated via gate-advance endpoint; reject if provided.
  if ("frozen_data" in body) {
    return Response.json({ error: "frozen_data is read-only" }, { status: 400 });
  }

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
  if (typeof body["due_date"] === "string") { vals.push(body["due_date"].trim() || null); sets.push(`due_date = $${vals.length}`); }
  if (Array.isArray(body["labels"])) {
    // Store labels under metadata.labels (deduped, trimmed strings).
    const labels = [...new Set((body["labels"] as unknown[]).map((l) => String(l).trim()).filter(Boolean))];
    vals.push(JSON.stringify(labels));
    sets.push(`metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{labels}', $${vals.length}::jsonb, true)`);
  }
  if (Array.isArray(body["channels"])) {
    // Content workflow channels (linkedin, x, etc.) — validate against canonical list.
    const channels = [...new Set((body["channels"] as unknown[]).map((c) => String(c).trim()).filter(Boolean))];
    const invalid = channels.filter((c) => !CHANNELS.includes(c));
    if (invalid.length > 0) return Response.json({ error: `invalid channels: ${invalid.join(", ")}` }, { status: 400 });
    vals.push(JSON.stringify(channels));
    sets.push(`channels = $${vals.length}::jsonb`);
  }
  if (typeof body["conversation_id"] === "string" || body["conversation_id"] === null) {
    vals.push(body["conversation_id"]); sets.push(`conversation_id = $${vals.length}`);
  }
  if (typeof body["parent_card_id"] === "string" || body["parent_card_id"] === null) {
    vals.push(body["parent_card_id"]); sets.push(`parent_card_id = $${vals.length}`);
  }
  if (typeof body["publish_at"] === "string" || body["publish_at"] === null) {
    vals.push(body["publish_at"]); sets.push(`publish_at = $${vals.length}`);
  }
  // frozen_data is read-only and only updated via gate-advance endpoint; never allow direct modification.
  if (!sets.length) return Response.json({ error: "nothing to update" }, { status: 400 });

  const card = await withUser(sess.userId, async (c) => {
    // Verify user owns the card before updating.
    const ownership = await c.query(`select 1 from plugin_boards.cards where id = $1 and user_id = $2`, [id, sess.userId]);
    if (!ownership.rows.length) return undefined;

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
