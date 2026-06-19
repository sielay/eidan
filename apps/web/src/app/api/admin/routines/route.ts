// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/routines — the operator's recurring routines (eidan.routines) with each one's
// recent fire history (eidan.routine_runs). Routines are the substrate the amygdala proactive loop
// runs on, so this pane doubles as the "is the agent firing its scheduled work?" observability view.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select r.id, r.name, r.schedule, r.prompt, r.enabled, r.last_run_at,
              r.created_at, r.updated_at,
              coalesce(runs.recent, '[]'::json) as recent_runs
         from eidan.routines r
         left join lateral (
           select json_agg(
                    json_build_object(
                      'fired_for', rr.fired_for,
                      'status', rr.status,
                      'detail', rr.detail,
                      'created_at', rr.created_at
                    ) order by rr.created_at desc
                  ) as recent
             from (
               select fired_for, status, detail, created_at
                 from eidan.routine_runs
                where routine_id = r.id
                order by created_at desc
                limit 5
             ) rr
         ) runs on true
        where r.user_id = $1 and r.deleted_at is null
        order by r.enabled desc, r.name asc`,
      [sess.userId],
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    routines: rows.map((r) => ({
      id: r.id,
      name: r.name,
      schedule: r.schedule,
      prompt: r.prompt ?? "",
      enabled: Boolean(r.enabled),
      last_run_at: r.last_run_at ? iso(r.last_run_at) : null,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      recent_runs: ((r.recent_runs as Array<Record<string, unknown>> | null) ?? []).map(
        (run) => ({
          fired_for: String(run.fired_for ?? ""),
          status: String(run.status ?? ""),
          detail: run.detail == null ? null : String(run.detail),
          created_at: iso(run.created_at),
        }),
      ),
    })),
  });
}
