// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/usage/timeseries — costs/tokens bucketed by day/week/month
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Interval = "day" | "week" | "month";
type GroupBy = "provider" | "model" | "node";

const BUCKET_CONFIG: Record<Interval, { datetrunc: string; format: string }> = {
  day: { datetrunc: "day", format: "YYYY-MM-DD" },
  week: { datetrunc: "week", format: "YYYY-MM-DD" },
  month: { datetrunc: "month", format: "YYYY-MM" },
};

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const startDate = req.nextUrl.searchParams.get("start_date") ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const endDate = req.nextUrl.searchParams.get("end_date") ?? new Date().toISOString().split("T")[0];
  const intervalParam = (req.nextUrl.searchParams.get("interval") ?? "day") as Interval;
  const groupByParam = (req.nextUrl.searchParams.get("group_by") ?? "provider") as GroupBy;

  const interval = BUCKET_CONFIG[intervalParam] ?? BUCKET_CONFIG.day;
  const groupByCols: Record<GroupBy, string> = {
    provider: "provider",
    model: "model",
    node: "metadata->>'node_id'",
  };
  const groupByCol = groupByCols[groupByParam] ?? groupByCols.provider;

  const data = await withUser(sess.userId, async (c) => {
    const datetrunc = interval.datetrunc;
    const rows = await c.query(
      `select
        date_trunc($4, started_at)::date as bucket,
        ${groupByCol} as group_key,
        coalesce(sum(cost_usd), 0)::numeric as cost_usd,
        coalesce(sum(input_tokens), 0)::int as input_tokens,
        coalesce(sum(output_tokens), 0)::int as output_tokens,
        coalesce(sum(cache_read_tokens), 0)::int as cache_read_tokens,
        coalesce(sum(cache_creation_tokens), 0)::int as cache_creation_tokens
       from eidan.llm_calls
      where user_id=$1 and started_at >= $2::timestamp and started_at < ($3::date + interval '1 day')
      group by bucket, ${groupByCol}
      order by bucket, group_key`,
      [sess.userId, startDate, endDate, datetrunc],
    );
    return rows.rows;
  });

  return Response.json({
    interval: intervalParam,
    group_by: groupByParam,
    data: (data as Array<Record<string, unknown>>).map((row) => ({
      bucket: iso(row.bucket),
      group: String(row.group_key),
      cost_usd: Number(row.cost_usd ?? 0),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      cache_read_tokens: Number(row.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(row.cache_creation_tokens ?? 0),
    })),
  });
}
