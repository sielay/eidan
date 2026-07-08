// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/content/card — full detail for one content card (the workflow drawer): the card + its assets,
// per-channel copy, schedule, refs and activity. PUT drives the workflow: advance the stage (freezes +
// logs), approve/reject an asset, save a channel's copy. Owner-scoped (verifyBearer + withUser RLS).
//   GET  ?id=<cardId>  → { card, assets, copy, schedule, refs, activity }
//   PUT  { id, action: 'advance'|'approve_asset'|'reject_asset'|'save_copy', ... }
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAGES = ["concept", "assets", "copy", "distribution", "scheduled", "published"];
const nextStage = (s: string): string => {
  const i = STAGES.indexOf(s === "review" ? "distribution" : s);
  return i >= 0 && i + 1 < STAGES.length ? STAGES[i + 1] : s;
};

// The Content Filter: a post passes only if it names the product/outcome it moves toward, the buyer's
// outcome, confirms it moves them one step closer, and picks exactly one CTA (follow/comment/dm/link).
const CTAS = ["follow", "comment", "dm", "link"];
function filterPasses(f: unknown): boolean {
  if (!f || typeof f !== "object") return false;
  const x = f as { product?: unknown; buyer_outcome?: unknown; moves_closer?: unknown; cta?: unknown };
  return typeof x.product === "string" && x.product.trim().length > 0
    && typeof x.buyer_outcome === "string" && x.buyer_outcome.trim().length > 0
    && x.moves_closer === true
    && typeof x.cta === "string" && CTAS.includes(x.cta);
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const data = await withUser(sess.userId, async (c) => {
    const cr = await c.query(
      `select k.id, k.title, k.body, k.status, k.conversation_id, k.parent_card_id, k.publish_at, k.channels, k.metadata,
              b.scope_id as venture_id
         from plugin_boards.cards k join plugin_boards.boards b on b.id = k.board_id
        where k.id = $1 and k.user_id = $2`,
      [id, sess.userId],
    );
    const card = cr.rows[0];
    if (!card) return null;
    const filter = (card.metadata && typeof card.metadata === "object" ? (card.metadata as { content_filter?: unknown }).content_filter : null) ?? null;
    const [assets, copy, sched, refs, activity] = await Promise.all([
      c.query(`select id, ref_id, ref_kind, approval_state, metadata from plugin_content.card_assets where card_id=$1 and user_id=$2 order by created_at`, [id, sess.userId]),
      c.query(`select channel, body, state from plugin_content.card_copy where card_id=$1 and user_id=$2 order by channel`, [id, sess.userId]),
      c.query(`select publish_at, frozen_plan, execution_status from plugin_content.card_schedule where card_id=$1 and user_id=$2`, [id, sess.userId]),
      c.query(`select ref_kind, ref_id, ref_label from plugin_boards.card_refs where card_id=$1 and user_id=$2`, [id, sess.userId]),
      c.query(`select kind, body, created_at from plugin_boards.card_events where card_id=$1 and user_id=$2 order by created_at desc limit 20`, [id, sess.userId]),
    ]);
    return {
      card: { ...card, channels: Array.isArray(card.channels) ? card.channels : [] },
      filter, assets: assets.rows, copy: copy.rows, schedule: sched.rows[0] ?? null, refs: refs.rows, activity: activity.rows,
    };
  });
  if (!data) return Response.json({ error: "no such card" }, { status: 404 });
  return Response.json(data);
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const id = typeof body["id"] === "string" ? body["id"] : "";
  const action = typeof body["action"] === "string" ? body["action"] : "";
  if (!id || !action) return Response.json({ error: "id and action required" }, { status: 400 });

  const result = await withUser(sess.userId, async (c) => {
    if (action === "advance") {
      const cur = await c.query(`select status, metadata from plugin_boards.cards where id=$1 and user_id=$2`, [id, sess.userId]);
      if (!cur.rowCount) return { error: "no such card" };
      const stage = String(cur.rows[0].status) === "review" ? "distribution" : String(cur.rows[0].status);
      // Content Filter gate — a post cannot leave Copy for Distribution unless it passes all 3 questions
      // and names exactly one CTA. Baked into the workflow so nothing ships that isn't selling something.
      if (stage === "copy" && !filterPasses((cur.rows[0].metadata as { content_filter?: unknown } | null)?.content_filter)) {
        return { error: "content_filter", message: "This post must pass the Content Filter before it can move to Distribution." };
      }
      const next = nextStage(String(cur.rows[0].status));
      await c.query(`update plugin_boards.cards set status=$3, updated_at=now() where id=$1 and user_id=$2`, [id, sess.userId, next]);
      await c.query(`insert into plugin_boards.card_events (card_id, user_id, kind, body) values ($1,$2,'status',$3)`, [id, sess.userId, `advanced to ${next}`]);
      return { ok: true, status: next };
    }
    if (action === "save_filter") {
      const f = body["filter"];
      if (!f || typeof f !== "object") return { error: "filter required" };
      await c.query(`update plugin_boards.cards set metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{content_filter}', $3::jsonb, true), updated_at=now() where id=$1 and user_id=$2`, [id, sess.userId, JSON.stringify(f)]);
      return { ok: true, passes: filterPasses(f) };
    }
    if (action === "approve_asset" || action === "reject_asset") {
      const assetId = typeof body["asset_id"] === "string" ? body["asset_id"] : "";
      const state = action === "approve_asset" ? "approved" : "rejected";
      const r = await c.query(`update plugin_content.card_assets set approval_state=$3, updated_at=now() where id=$1 and user_id=$2 returning id`, [assetId, sess.userId, state]);
      return r.rowCount ? { ok: true } : { error: "no such asset" };
    }
    if (action === "save_copy") {
      const channel = typeof body["channel"] === "string" ? body["channel"] : "";
      const text = typeof body["body"] === "string" ? body["body"] : "";
      if (!channel) return { error: "channel required" };
      await c.query(
        `insert into plugin_content.card_copy (card_id, user_id, channel, body, state) values ($1,$2,$3,$4,$5)
         on conflict (card_id, channel) do update set body=excluded.body, state=excluded.state, updated_at=now()`,
        [id, sess.userId, channel, text || null, text.trim() ? "draft" : "empty"],
      );
      return { ok: true };
    }
    return { error: `unknown action ${action}` };
  });
  if ((result as { error?: string }).error) return Response.json(result, { status: 400 });
  return Response.json(result);
}
