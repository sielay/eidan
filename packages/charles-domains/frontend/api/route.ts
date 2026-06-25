// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface DomainRow {
  id: string;
  name: string;
  registrar: string;
  status: string;
  expires_at: string | null;
  auto_renew: boolean | null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const payload = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, name, registrar, status, expires_at, auto_renew
         from plugin_charles_domains.domains
        where user_id = $1 and status = 'active'
        order by created_at desc`,
      [sess.userId],
    );
    // Best-effort: which venture (if any) each domain is attached to (kind 'domain'), so the screen
    // can show "↳ <venture>". Wrapped — the Charles ventures bundle is optional.
    type Link = { external_ref: string; connection_id: string | null; venture_id: string; venture_name: string };
    let links: Link[] = [];
    try {
      const lr = await c.query(
        `select vr.external_ref, vr.metadata->>'connection_id' as connection_id, vn.id as venture_id, vn.name as venture_name
           from plugin_ventures.venture_resources vr
           join plugin_ventures.ventures vn on vn.id = vr.venture_id and vn.status = 'active'
          where vr.user_id = $1 and vr.status = 'active' and vr.kind = 'domain'`,
        [sess.userId],
      );
      links = lr.rows as Link[];
    } catch { /* ventures bundle not installed */ }

    const domains = (r.rows as DomainRow[]).map((row) => {
      const link = links.find((l) => l.connection_id === row.id || l.external_ref === row.name);
      return {
        id: row.id,
        name: row.name,
        registrar: row.registrar,
        status: row.status,
        expires_at: row.expires_at,
        auto_renew: row.auto_renew,
        ...(link ? { venture_id: link.venture_id, venture_name: link.venture_name } : {}),
      };
    });
    return { domains };
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

  const name = typeof body["name"] === "string" ? body["name"].trim().toLowerCase() : "";
  const registrar = typeof body["registrar"] === "string" ? body["registrar"].trim() : "manual";
  const expiresAt = body["expires_at"] ? new Date(String(body["expires_at"])) : null;
  const autoRenew = body["auto_renew"] ? Boolean(body["auto_renew"]) : null;

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!["godaddy", "cyberfolks", "manual"].includes(registrar)) {
    return Response.json({ error: "invalid registrar" }, { status: 400 });
  }

  try {
    const domain = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `insert into plugin_charles_domains.domains
            (user_id, registrar, name, expires_at, auto_renew)
         values ($1, $2, $3, $4, $5)
         returning id, name, registrar, status, expires_at, auto_renew`,
        [sess.userId, registrar, name, expiresAt, autoRenew],
      );
      return r.rows[0] as DomainRow;
    });
    return Response.json({ ok: true, domain }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique/i.test(msg)) {
      return Response.json({ error: "domain already exists" }, { status: 409 });
    }
    return Response.json({ error: "could not create domain" }, { status: 500 });
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
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  try {
    await withUser(sess.userId, async (c) => {
      const updates: string[] = [];
      const params: unknown[] = [id, sess.userId];
      let paramIndex = 3;

      if (body["expires_at"] !== undefined) {
        const expiresAt = body["expires_at"] ? new Date(String(body["expires_at"])) : null;
        updates.push(`expires_at = $${paramIndex}`);
        params.push(expiresAt);
        paramIndex++;
      }

      if (body["auto_renew"] !== undefined) {
        updates.push(`auto_renew = $${paramIndex}`);
        params.push(body["auto_renew"] ? Boolean(body["auto_renew"]) : null);
        paramIndex++;
      }

      if (body["status"] !== undefined) {
        updates.push(`status = $${paramIndex}`);
        params.push(body["status"]);
        paramIndex++;
      }

      if (updates.length === 0) return;

      updates.push("updated_at = now()");
      await c.query(
        `update plugin_charles_domains.domains
          set ${updates.join(", ")}
         where id = $1 and user_id = $2`,
        params,
      );
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: "could not update domain" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  try {
    await withUser(sess.userId, async (c) => {
      await c.query(
        `update plugin_charles_domains.domains
          set status = 'archived', updated_at = now()
         where id = $1 and user_id = $2`,
        [id, sess.userId],
      );
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: "could not archive domain" }, { status: 500 });
  }
}
