// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/usage/recent-calls — recent individual calls (paginated, filterable)
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser, iso } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const limit = Math.min(Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "50")), 500);
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") ?? "0"));
  const provider = req.nextUrl.searchParams.get("provider");
  const model = req.nextUrl.searchParams.get("model");
  const role = req.nextUrl.searchParams.get("role");
  const since = req.nextUrl.searchParams.get("since");

  let whereClause = "user_id=$1";
  const params: (string | number)[] = [sess.userId];

  if (provider) {
    whereClause += " and provider=$" + (params.length + 1);
    params.push(provider);
  }
  if (model) {
    whereClause += " and model=$" + (params.length + 1);
    params.push(model);
  }
  if (role) {
    whereClause += " and role=$" + (params.length + 1);
    params.push(role);
  }
  if (since) {
    whereClause += " and started_at >= $" + (params.length + 1);
    params.push(since);
  }

  const data = await withUser(sess.userId, async (c) => {
    const count = await c.query(`select count(*)::int as n from eidan.llm_calls where ${whereClause}`, params);
    const rows = await c.query(
      `select
        id, conversation_id, message_id, agent_id, provider, model, role,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cost_usd, latency_ms, error, request_id, started_at, finished_at
       from eidan.llm_calls
      where ${whereClause}
      order by started_at desc
      limit $` +
        (params.length + 1) +
        ` offset $` +
        (params.length + 2),
      [...params, limit, offset],
    );
    return { count: count.rows[0], rows: rows.rows };
  });

  return Response.json({
    total: Number((data.count as Record<string, unknown>)?.n ?? 0),
    limit,
    offset,
    calls: ((data.rows as Array<Record<string, unknown>>) ?? []).map((row) => ({
      id: String(row.id),
      conversation_id: row.conversation_id ? String(row.conversation_id) : null,
      message_id: row.message_id ? String(row.message_id) : null,
      agent_id: row.agent_id ? String(row.agent_id) : null,
      provider: String(row.provider),
      model: String(row.model),
      role: String(row.role),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      cache_read_tokens: Number(row.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(row.cache_creation_tokens ?? 0),
      cost_usd: Number(row.cost_usd ?? 0),
      latency_ms: row.latency_ms ? Number(row.latency_ms) : null,
      error: row.error ? String(row.error) : null,
      request_id: row.request_id ? String(row.request_id) : null,
      started_at: iso(row.started_at),
      finished_at: row.finished_at ? iso(row.finished_at) : null,
    })),
  });
}
