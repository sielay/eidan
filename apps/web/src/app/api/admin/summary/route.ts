// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/summary?window=1h|24h|7d — the activity dashboard rollup: jobs by status/kind
// (eidan.jobs), an hourly/daily event histogram (eidan.node_events), and turn totals + cost
// (eidan.llm_calls).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOWS: Record<string, { interval: string; bucket: string }> = {
  "1h": { interval: "1 hour", bucket: "minute" },
  "24h": { interval: "24 hours", bucket: "hour" },
  "7d": { interval: "7 days", bucket: "day" },
};

function tally(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r[key])] = Number(r.n);
  return out;
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const w = req.nextUrl.searchParams.get("window") ?? "24h";
  const { interval, bucket } = WINDOWS[w] ?? WINDOWS["24h"]!;
  const win = w in WINDOWS ? w : "24h";

  const data = await withUser(sess.userId, async (c) => {
    const byStatus = await c.query(
      "select status, count(*)::int as n from eidan.jobs where user_id=$1 group by status",
      [sess.userId],
    );
    const byKind = await c.query(
      "select kind, count(*)::int as n from eidan.jobs where user_id=$1 group by kind",
      [sess.userId],
    );
    const buckets = await c.query(
      `select date_trunc('${bucket}', ts) as b,
              count(*) filter (where type not ilike '%error%')::int as turns,
              count(*) filter (where type ilike '%error%')::int as errors
         from eidan.node_events where ts >= now() - interval '${interval}'
         group by b order by b`,
    );
    const totals = await c.query(
      `select count(*) filter (where error is null)::int as complete,
              count(*) filter (where error is not null)::int as error,
              coalesce(sum(cost_usd), 0) as cost
         from eidan.llm_calls where user_id=$1 and started_at >= now() - interval '${interval}'`,
      [sess.userId],
    );
    return { byStatus: byStatus.rows, byKind: byKind.rows, buckets: buckets.rows, totals: totals.rows[0] };
  });

  const t = (data.totals as Record<string, unknown>) ?? {};
  return Response.json({
    window: win,
    jobs_by_status: tally(data.byStatus as Array<Record<string, unknown>>, "status"),
    jobs_by_kind: tally(data.byKind as Array<Record<string, unknown>>, "kind"),
    events_by_bucket: (data.buckets as Array<Record<string, unknown>>).map((r) => ({
      ts: iso(r.b),
      turns: Number(r.turns),
      errors: Number(r.errors),
    })),
    turn_totals: {
      complete: Number(t.complete ?? 0),
      error: Number(t.error ?? 0),
      cost_usd: Number(t.cost ?? 0),
    },
  });
}
