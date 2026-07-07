// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/fs/settings — the operator's file-upload destination preference (eidan.kv settings/fs_upload),
// read by the engine's fs writer/presigner. GET returns { offload, direct }; PUT saves them. Keeps the
// choice of where uploads land (Postgres vs object storage, direct vs proxied) out of env, in the UI.
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OFFLOADS = ["auto", "always", "never"];

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const doc = await withUser(sess.userId, async (c) => {
    const r = await c.query(`select doc from eidan.kv where namespace = 'settings' and id = 'fs_upload'`);
    return ((r.rows[0] as { doc?: Record<string, unknown> } | undefined)?.doc) ?? {};
  });
  const off = String(doc["offload"] ?? "auto");
  return Response.json({
    offload: OFFLOADS.includes(off) ? off : "auto",
    direct: typeof doc["direct"] === "boolean" ? doc["direct"] : null,
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  const doc: Record<string, unknown> = {};
  if (typeof body["offload"] === "string" && OFFLOADS.includes(body["offload"] as string)) doc["offload"] = body["offload"];
  else doc["offload"] = "auto";
  if (typeof body["direct"] === "boolean") doc["direct"] = body["direct"];
  else if (body["direct"] === null) doc["direct"] = null;

  await withUser(sess.userId, async (c) => {
    await c.query(
      `insert into eidan.kv (namespace, id, version, doc) values ('settings', 'fs_upload', $1, $2::jsonb)
       on conflict (namespace, id) do update set version = excluded.version, doc = excluded.doc, updated_at = now()`,
      [randomUUID(), JSON.stringify(doc)],
    );
  });
  return Response.json({ ok: true, ...doc });
}
