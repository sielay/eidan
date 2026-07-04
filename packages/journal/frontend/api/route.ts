// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/journal — list the operator's journal entries (Surface B: Next-reads-Postgres, owner-scoped
// over plugin_journal.entries via RLS). Capture is NOT here: it runs through the engine (POST
// /api/turn → journal_capture tool) so the LLM categorisation + sage-job routing happen in one place.
//   GET ?project=&entry_type=&limit=  → { entries }
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

interface Row { id: string; project: string | null; entry_type: string; summary: string; target_repo: string | null; job_id: string | null; created_at: unknown }
const TYPES = new Set(["devlog", "bug", "task", "idea", "content_seed"]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const project = req.nextUrl.searchParams.get("project")?.trim() || null;
  const type = req.nextUrl.searchParams.get("entry_type")?.trim() || null;
  const limRaw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limRaw) ? Math.min(Math.max(limRaw, 1), 200) : 50;

  const entries = await withUser(sess.userId, async (c) => {
    const vals: unknown[] = [sess.userId];
    let where = "user_id = $1 and deleted_at is null";
    if (project) { vals.push(project); where += ` and project = $${vals.length}`; }
    if (type && TYPES.has(type)) { vals.push(type); where += ` and entry_type = $${vals.length}`; }
    vals.push(limit);
    const r = await c.query(
      `select id, project, entry_type, summary, target_repo, job_id, created_at
         from plugin_journal.entries where ${where}
        order by created_at desc limit $${vals.length}`,
      vals,
    );
    return (r.rows as Row[]).map((row) => ({
      id: row.id,
      project: row.project,
      entry_type: row.entry_type,
      summary: row.summary,
      target_repo: row.target_repo,
      job_id: row.job_id,
      created_at: iso(row.created_at),
    }));
  });

  return Response.json({ entries });
}
