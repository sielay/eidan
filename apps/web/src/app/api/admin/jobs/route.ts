// SPDX-License-Identifier: AGPL-3.0-or-later
// GET  /api/admin/jobs — the jobs queue (eidan.jobs), newest first.
// POST /api/admin/jobs — enqueue a job (the "clone" path: an edited copy of an existing one).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 100, 500);

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, kind, goal, payload, status, surface, claimed_by, claimed_at, result, error, created_at, updated_at
         from eidan.jobs where user_id = $1 order by created_at desc limit ${limit}`,
      [sess.userId],
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    jobs: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      goal: r.goal ?? "",
      payload: (r.payload as Record<string, unknown>) ?? {},
      status: r.status,
      surface: r.surface ?? null,
      claimed_by: r.claimed_by ?? null,
      claimed_at: r.claimed_at ? iso(r.claimed_at) : null,
      result: (r.result as Record<string, unknown>) ?? {},
      error: r.error ?? null,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    })),
  });
}

interface CreateJobBody {
  kind?: unknown;
  goal?: unknown;
  payload?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: CreateJobBody;
  try {
    body = (await req.json()) as CreateJobBody;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }

  const kind = typeof body.kind === "string" && body.kind.trim() ? body.kind.trim() : "code";
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) return new Response("goal is required", { status: 400 });
  const payload =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : {};

  const created = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into eidan.jobs (kind, goal, payload, user_id, status, surface)
         values ($1, $2, $3, $4, 'queued', 'clone')
       returning id, status`,
      [kind, goal, JSON.stringify(payload), sess.userId],
    );
    return r.rows[0] as { id: string; status: string };
  });

  return Response.json({ id: created.id, status: created.status });
}
