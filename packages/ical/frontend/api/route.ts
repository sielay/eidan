// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/ical/calendars — the Calendars admin data route (Next-reads-Postgres, the Surface-B pattern).
// Manages the operator's named calendars in plugin_ical.calendars and seals each feed URL into the
// vault via the engine's secrets-api (the LLM-free write path). Owner-scoped; shipped in the bundle's
// frontend package, mounted under apps/web at deploy.
//   GET                          → { calendars: [{ id, name, slug, context, vault_key }] }
//   POST   { name, url, context }→ seal url in vault + insert row
//   PUT    { id, context?, url? }→ update the context note (and/or re-seal the URL)
//   DELETE ?id=<id>              → archive the row + remove its vault secret
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CalendarRow {
  id: string;
  name: string;
  slug: string;
  context: string;
  vault_key: string;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "calendar";
}

// Seal/replace a value in the vault via the engine's secrets-api, forwarding the caller's bearer.
// The engine encrypts it and scopes it to the user — the web never sees the master key.
async function vaultPut(req: NextRequest, key: string, value: string): Promise<boolean> {
  const engine = process.env.EIDAN_ENGINE_URL;
  const auth = req.headers.get("authorization");
  if (!engine || !auth) return false;
  const r = await fetch(`${engine}/api/me/secrets/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  return r.ok;
}

async function vaultDelete(req: NextRequest, key: string): Promise<void> {
  const engine = process.env.EIDAN_ENGINE_URL;
  const auth = req.headers.get("authorization");
  if (!engine || !auth) return;
  await fetch(`${engine}/api/me/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { authorization: auth },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const payload = await withUser(sess.userId, async (c) => {
    const cal = await c.query(
      `select id, name, slug, context, vault_key
         from plugin_ical.calendars
        where user_id = $1 and status = 'active'
        order by created_at`,
      [sess.userId],
    );
    const set = await c.query(`select routine, timezone from plugin_ical.settings where user_id = $1`, [
      sess.userId,
    ]);
    const row = set.rows[0] as { routine?: string; timezone?: string } | undefined;
    return {
      calendars: cal.rows as CalendarRow[],
      routine: row?.routine ?? "",
      timezone: row?.timezone ?? "",
    };
  });
  return Response.json(payload);
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const url = typeof body["url"] === "string" ? body["url"].trim() : "";
  const context = typeof body["context"] === "string" ? body["context"].trim() : "";
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) {
    return Response.json({ error: "url must be an http(s) .ics / CalDAV feed" }, { status: 400 });
  }

  const slug = slugify(name);
  const vaultKey = `EIDAN_ICAL_FEED_${slug}`;

  // Seal the URL first; only record the calendar once the vault write has succeeded.
  if (!(await vaultPut(req, vaultKey, url))) {
    return Response.json({ error: "could not store the feed URL in the vault" }, { status: 502 });
  }

  try {
    const calendar = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `insert into plugin_ical.calendars (user_id, name, slug, context, vault_key)
         values ($1, $2, $3, $4, $5)
         returning id, name, slug, context, vault_key`,
        [sess.userId, name, slug, context, vaultKey],
      );
      return r.rows[0] as CalendarRow;
    });
    return Response.json({ ok: true, calendar });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_ical_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "you already have a calendar with that name" }, { status: 409 });
    }
    return Response.json({ error: "could not create calendar" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const id = typeof body["id"] === "string" ? body["id"].trim() : "";

  // Routine update (no calendar id): upsert the user's general across-calendars routine note.
  if (!id && typeof body["routine"] === "string") {
    const routine = (body["routine"] as string).trim();
    await withUser(sess.userId, async (c) => {
      await c.query(
        `insert into plugin_ical.settings (user_id, routine) values ($1, $2)
         on conflict (user_id) do update set routine = $2, updated_at = now()`,
        [sess.userId, routine],
      );
    });
    return Response.json({ ok: true });
  }

  // Timezone update (no calendar id): the operator's IANA zone, captured from the browser.
  if (!id && typeof body["timezone"] === "string") {
    const timezone = (body["timezone"] as string).trim().slice(0, 64);
    await withUser(sess.userId, async (c) => {
      await c.query(
        `insert into plugin_ical.settings (user_id, timezone) values ($1, $2)
         on conflict (user_id) do update set timezone = $2, updated_at = now()`,
        [sess.userId, timezone],
      );
    });
    return Response.json({ ok: true });
  }

  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const context = typeof body["context"] === "string" ? body["context"].trim() : null;
  const url = typeof body["url"] === "string" ? body["url"].trim() : null;

  const cal = await withUser(sess.userId, async (c) => {
    const owns = await c.query(
      `select id, vault_key from plugin_ical.calendars
        where id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    if (owns.rowCount === 0) return null;
    if (context !== null) {
      await c.query(
        `update plugin_ical.calendars set context = $1, updated_at = now()
          where id = $2 and user_id = $3`,
        [context, id, sess.userId],
      );
    }
    return owns.rows[0] as { id: string; vault_key: string };
  });
  if (!cal) return Response.json({ error: "no such calendar" }, { status: 404 });

  if (url && /^https?:\/\//i.test(url)) {
    if (!(await vaultPut(req, cal.vault_key, url))) {
      return Response.json({ error: "could not update the feed URL in the vault" }, { status: 502 });
    }
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const removed = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_ical.calendars set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status = 'active'
        returning vault_key`,
      [id, sess.userId],
    );
    return r.rows[0] as { vault_key: string } | undefined;
  });
  if (!removed) return Response.json({ error: "no such calendar" }, { status: 404 });
  await vaultDelete(req, removed.vault_key);
  return Response.json({ ok: true });
}
