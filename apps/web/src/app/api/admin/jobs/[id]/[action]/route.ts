// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/admin/jobs/{id}/{retry|cancel|archive|unarchive} — operator controls on eidan.jobs.
// retry re-queues a settled job (done/failed/cancelled → queued, freeing the lease + clearing the
// prior error); cancel stops a live one (queued/claimed/running → cancelled); archive/unarchive
// toggle the soft-archive flag (hide a settled job from the active board). RLS-scoped to the
// caller's own jobs; a no-op (wrong state / not owned) returns 409.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SQL: Record<string, string> = {
  retry: `update eidan.jobs
            set status = 'queued', claimed_by = null, claimed_at = null, error = null, updated_at = now()
          where id = $1 and user_id = $2 and status in ('done','failed','cancelled')
          returning status`,
  cancel: `update eidan.jobs
             set status = 'cancelled', updated_at = now()
           where id = $1 and user_id = $2 and status in ('queued','claimed','running')
           returning status`,
  archive: `update eidan.jobs
              set archived_at = now(), updated_at = now()
            where id = $1 and user_id = $2 and archived_at is null
            returning status`,
  unarchive: `update eidan.jobs
                set archived_at = null, updated_at = now()
              where id = $1 and user_id = $2 and archived_at is not null
              returning status`,
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id, action } = await params;
  const sql = SQL[action];
  if (!sql) return new Response("unknown action", { status: 400 });

  const status = await withUser(sess.userId, async (c) => {
    const r = await c.query(sql, [id, sess.userId]);
    return (r.rows[0] as { status?: string } | undefined)?.status ?? null;
  });

  if (status === null) {
    return new Response("job not found or not in a state that allows this action", { status: 409 });
  }
  return Response.json({ id, status });
}
