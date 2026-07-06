// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/content/board — the CENTRAL content board: every content card across all ventures, for a
// cross-venture kanban (ventures = swimlanes, content-workflow stage = columns). Aggregates the
// per-venture "Campaigns" boards (plugin_boards, scope_kind='content') joined to the venture name.
// Owner-scoped via RLS + explicit user_id. Card moves reuse the boards API (PUT /api/boards/cards).
//   GET → { cards: [{ id, title, body, status, venture_id, venture_name, labels, board_id }] }
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row { id: string; title: string; body: string | null; status: string; venture_id: string | null; venture_name: string | null; venture_slug: string | null; metadata: { labels?: string[] } | null; board_id: string; source_conv: string | null }

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const cards = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select k.id, k.title, k.body, k.status, k.metadata, k.board_id,
              b.scope_id as venture_id, v.name as venture_name, v.slug as venture_slug,
              (select cr.ref_id from plugin_boards.card_refs cr
                 where cr.card_id = k.id and cr.ref_kind = 'conversation' limit 1) as source_conv
         from plugin_boards.cards k
         join plugin_boards.boards b on b.id = k.board_id and b.status = 'active'
         left join plugin_ventures.ventures v on v.id::text = b.scope_id
        where k.user_id = $1 and b.scope_kind = 'content' and k.status <> 'archived'
        order by v.name nulls last, k.position, k.created_at`,
      [sess.userId],
    );
    return (r.rows as Row[]).map((x) => ({
      id: x.id,
      title: x.title,
      body: x.body,
      status: x.status,
      venture_id: x.venture_id,
      venture_name: x.venture_name ?? "Unassigned",
      venture_slug: x.venture_slug,
      labels: Array.isArray(x.metadata?.labels) ? x.metadata.labels : [],
      board_id: x.board_id,
      source_conv: x.source_conv,
    }));
  });
  return Response.json({ cards });
}
