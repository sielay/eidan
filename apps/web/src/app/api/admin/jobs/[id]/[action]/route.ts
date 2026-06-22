// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/admin/jobs/{id}/{retry|cancel|archive|unarchive|verify} — operator controls on eidan.jobs.
// retry re-queues a settled job (done/failed/cancelled → queued, freeing the lease + clearing the
// prior result/error so it's a fresh attempt); cancel stops a live one (queued/claimed/running →
// cancelled); archive/unarchive toggle the soft-archive flag. verify is read-only: it checks whether
// the PR a settled job claims to have opened actually exists on GitHub (the lease-collision bug could
// bury a job as `done` with no PR — verify tells real-PR from phantom). RLS-scoped to the caller's
// own jobs; a no-op mutation (wrong state / not owned) returns 409.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SQL: Record<string, string> = {
  // retry also clears result so a buried/phantom-PR job doesn't carry a stale pr_url into the re-run.
  retry: `update eidan.jobs
            set status = 'queued', claimed_by = null, claimed_at = null, result = null, error = null, updated_at = now()
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

interface VerifyVerdict {
  ok: boolean; // a live PR was found
  state?: string; // open | closed | merged | missing
  url?: string;
  reason?: string;
}

function prUrlOf(result: Record<string, unknown> | null): string | null {
  if (!result) return null;
  for (const k of ["pr_url", "prUrl"]) {
    const v = result[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

// Optional token so private-repo PRs (e.g. eidan-sage) can be verified too; public repos work unauth.
function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "eidan-jobs-verify" };
  const tok = process.env["EIDAN_GH_VERIFY_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (tok) h["Authorization"] = `Bearer ${tok}`;
  return h;
}

async function verifyJobPr(result: Record<string, unknown> | null): Promise<VerifyVerdict> {
  const url = prUrlOf(result);
  if (!url) {
    const status = result && typeof result["status"] === "string" ? (result["status"] as string) : null;
    return {
      ok: false,
      reason:
        status === "requeue"
          ? "no PR — the job was re-queued (workspace lease busy) and never coded. Retry it."
          : "no pull-request URL recorded in the result.",
    };
  }
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url);
  if (!m) return { ok: false, url, reason: "result has a PR URL but it isn't a recognisable GitHub PR link." };
  const [, owner, repo, num] = m;
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${num}`, { headers: ghHeaders() });
    if (res.status === 404) return { ok: false, state: "missing", url, reason: "PR not found on GitHub (never created, or deleted)." };
    if (res.status === 403) return { ok: false, url, reason: "couldn't verify (GitHub 403 — private repo without a token, or rate-limited)." };
    if (!res.ok) return { ok: false, url, reason: `couldn't verify (GitHub ${res.status}).` };
    const pr = (await res.json()) as { state?: string; merged_at?: string | null };
    const state = pr.merged_at ? "merged" : pr.state ?? "open";
    return { ok: true, state, url };
  } catch (e) {
    return { ok: false, url, reason: `couldn't reach GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const { id, action } = await params;

  if (action === "verify") {
    const result = await withUser(sess.userId, async (c) => {
      const r = await c.query(`select result from eidan.jobs where id = $1 and user_id = $2`, [id, sess.userId]);
      const row = r.rows[0] as { result?: Record<string, unknown> } | undefined;
      return row ? (row.result ?? null) : undefined;
    });
    if (result === undefined) return new Response("job not found", { status: 404 });
    const verdict = await verifyJobPr(result);
    return Response.json({ id, verify: verdict });
  }

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
