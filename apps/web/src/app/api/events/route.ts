// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/events — the caller's events/reminders (eidan.events), shaped for the Memory screen's
// Events tab: a human "when", a status, and a colour zone derived from due date + status.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";
import { relTime } from "@/server/reltime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UiStatus = "due" | "today" | "pending" | "done";
type Zone = "good" | "info" | "warn" | "alert";

function classify(dbStatus: unknown, dueAt: unknown): { status: UiStatus; zone: Zone } {
  const s = String(dbStatus ?? "").toLowerCase();
  if (s === "done" || s === "completed" || s === "resolved") return { status: "done", zone: "good" };
  if (!dueAt) return { status: "pending", zone: "info" };
  const due = new Date(String(dueAt)).getTime();
  const now = Date.now();
  const dayMs = 86_400_000;
  if (due < now) return { status: "due", zone: "alert" }; // overdue
  if (due - now < dayMs) return { status: "today", zone: "warn" };
  if (due - now < 3 * dayMs) return { status: "pending", zone: "warn" };
  return { status: "pending", zone: "info" };
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 200, 500);

  const rows = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, type, title, body, due_at, occurred_at, status
         from eidan.events where user_id = $1 and deleted_at is null
         order by coalesce(due_at, occurred_at, created_at) desc nulls last limit ${limit}`,
      [sess.userId],
    );
    return r.rows as Array<Record<string, unknown>>;
  });

  return Response.json({
    events: rows.map((r) => {
      const { status, zone } = classify(r.status, r.due_at);
      const whenSrc = r.due_at ?? r.occurred_at;
      return {
        id: r.id,
        title: (r.title as string) || (r.type as string) || "Event",
        when: status === "done" ? `done · ${relTime(r.occurred_at ?? r.due_at)}` : relTime(whenSrc),
        zone,
        status,
        note: (r.body as string) ?? "",
      };
    }),
  });
}

// POST /api/events — create a reminder-type event from the UI. due_at optional (ISO); blank → undated.
export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let title = "", body = "", dueAt: string | null = null;
  try {
    const b = (await req.json()) as { title?: unknown; body?: unknown; due_at?: unknown };
    title = (typeof b.title === "string" ? b.title : "").trim();
    body = typeof b.body === "string" ? b.body : "";
    if (typeof b.due_at === "string" && b.due_at.trim()) {
      const d = new Date(b.due_at);
      if (!Number.isNaN(d.getTime())) dueAt = d.toISOString();
    }
  } catch { return new Response("invalid JSON", { status: 400 }); }
  if (!title) return new Response("title required", { status: 400 });
  const row = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      "insert into eidan.events (user_id, type, title, body, due_at, status) values ($1, 'reminder', $2, $3, $4, 'pending') returning id",
      [sess.userId, title, body, dueAt],
    );
    return r.rows[0] as { id: string };
  });
  return Response.json({ event: { id: row.id } }, { status: 201 });
}
