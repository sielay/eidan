// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/notes — the caller's notes (eidan.notes), shaped for the Memory screen. The table stores
// free-text `content` + a `metadata` jsonb; title/tags/pinned are read from metadata when present,
// else derived from the content.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";
import { relTime } from "@/server/reltime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 200, 500);

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, content, metadata, updated_at
         from eidan.notes where user_id = $1 and deleted_at is null
         order by updated_at desc nulls last limit ${limit}`,
      [sess.userId],
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    notes: rows.map((r) => {
      const content = String(r.content ?? "");
      const meta = obj(r.metadata);
      const firstLine = content.split("\n").find((l) => l.trim() !== "")?.trim() ?? "Note";
      const title = typeof meta.title === "string" && meta.title ? meta.title : firstLine.slice(0, 80);
      const paras = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      return {
        id: r.id,
        title,
        snippet: content.replace(/\s+/g, " ").trim().slice(0, 120),
        tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
        updated: relTime(r.updated_at),
        pinned: meta.pinned === true,
        body: paras.length ? paras : [content.trim()].filter(Boolean),
      };
    }),
  });
}

// POST /api/notes — create a note from the Memory UI (the human counterpart to the agent's note tool).
export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let content = "";
  try {
    const b = (await req.json()) as { content?: unknown };
    if (typeof b.content === "string") content = b.content.trim();
  } catch { return new Response("invalid JSON", { status: 400 }); }
  if (!content) return new Response("content required", { status: 400 });
  const row = await withUser(sess.userId, async (c) => {
    const r = await c.query("insert into eidan.notes (user_id, content) values ($1, $2) returning id", [sess.userId, content]);
    return r.rows[0] as { id: string };
  });
  return Response.json({ note: { id: row.id } }, { status: 201 });
}
