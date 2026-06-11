// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/escalations[?status=pending|acknowledged|resolved|all&limit=] — the escalation inbox
// (docs/022 §3), newest first, RLS-scoped.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const status = req.nextUrl.searchParams.get("status");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 100, 500);

  const rows = await withUser(sess.userId, async (c) => {
    const params: unknown[] = [sess.userId];
    let where = "user_id = $1";
    if (status && status !== "all") {
      params.push(status);
      where += ` and status = $${params.length}`;
    }
    const r = await c.query(
      `select id, conversation_id, agent_id, severity, reason_class, suggested_action,
              evidence, metadata, status, created_at, updated_at, resolved_at
         from eidan.escalations where ${where}
         order by created_at desc limit ${limit}`,
      params,
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    escalations: rows.map((r) => ({
      id: r.id,
      conversation_id: r.conversation_id ?? null,
      agent_id: r.agent_id ?? null,
      severity: r.severity ?? "low",
      reason_class: r.reason_class ?? "",
      suggested_action: r.suggested_action ?? null,
      evidence: Array.isArray(r.evidence) ? r.evidence : [],
      metadata: (r.metadata as Record<string, unknown> | null) ?? {},
      status: r.status ?? "pending",
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      resolved_at: r.resolved_at ? iso(r.resolved_at) : null,
    })),
  });
}
