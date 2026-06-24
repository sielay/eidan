// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/social-bluesky/accounts — the Connections admin data route for Bluesky (Next-reads-Postgres,
// Surface-B). Bluesky has NO OAuth: the operator pastes a handle + app password (+ optional service
// URL), so this route is custom (it does NOT use the shared makeSocialAccountsRoute factory, which is
// for OAuth flavours). It seals the app password into the vault via the engine's secrets-api (the
// LLM-free write path) and records an ACTIVE account in plugin_social_bluesky.accounts — there is no
// consent redirect, so the connection completes synchronously. Owner-scoped; shipped in the bundle's
// frontend package, mounted under apps/web at deploy.
//   GET                                              → { accounts: [...] }
//   POST { name, handle, app_password, service? }    → seal the app password, upsert an active account
//   DELETE ?id=<id>                                  → archive the row + remove its vault secret
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SERVICE = "https://bsky.social";

interface AccountRow {
  id: string;
  name: string;
  slug: string;
  host: string;
  external_handle: string;
  status: string;
  token_expires_at: string | null;
  token_vault_key: string;
  context: string;
}

function slugify(name: string): string {
  // ReDoS-free trim (see note in _shared/socialAccountsRoute): collapse non-alnum to single '_', then
  // trim one leading + one trailing '_' anchored without '+'.
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_/, "")
    .replace(/_$/, "")
    .slice(0, 40);
  return s || "account";
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
  if (!engine || !auth || !key) return;
  await fetch(`${engine}/api/me/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { authorization: auth },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const accounts = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, name, slug, host, external_handle, status, token_expires_at, context
         from plugin_social_bluesky.accounts
        where user_id = $1 and status in ('active', 'pending')
        order by created_at`,
      [sess.userId],
    );
    return r.rows as Pick<
      AccountRow,
      "id" | "name" | "slug" | "host" | "external_handle" | "status" | "token_expires_at" | "context"
    >[];
  });
  return Response.json({ accounts });
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

  // Rename a connection and/or set its agent-facing context (slug + sealed password stay put).
  if (body["update"] && typeof body["update"] === "object") {
    const u = body["update"] as Record<string, unknown>;
    const id = typeof u["id"] === "string" ? u["id"] : "";
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    const newName = typeof u["name"] === "string" ? u["name"].trim() : null;
    const newContext = typeof u["context"] === "string" ? u["context"] : null;
    const ok = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `update plugin_social_bluesky.accounts
            set name = coalesce($3, name), context = coalesce($4, context), updated_at = now()
          where id = $1 and user_id = $2 and status in ('active', 'pending')`,
        [id, sess.userId, newName, newContext],
      );
      return (r.rowCount ?? 0) > 0;
    });
    return ok ? Response.json({ ok: true }) : Response.json({ error: "no such account" }, { status: 404 });
  }

  // Test: probe the connection live (engine mints a session with the sealed app password).
  if (typeof body["test"] === "string" && body["test"]) {
    const engine = process.env.EIDAN_ENGINE_URL;
    const auth = req.headers.get("authorization");
    if (!engine || !auth) return Response.json({ error: "engine unavailable" }, { status: 502 });
    const r = await fetch(`${engine}/api/me/social-bluesky/oauth/test`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ account_id: body["test"] }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json(j, { status: r.status });
  }

  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const handleRaw = typeof body["handle"] === "string" ? body["handle"].trim() : "";
  const appPassword = typeof body["app_password"] === "string" ? body["app_password"].trim() : "";
  const service = typeof body["service"] === "string" && body["service"].trim() ? body["service"].trim() : DEFAULT_SERVICE;
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!handleRaw) return Response.json({ error: "handle is required" }, { status: 400 });
  if (!appPassword) return Response.json({ error: "app_password is required" }, { status: 400 });

  const handle = handleRaw.replace(/^@/, "");
  const slug = slugify(name);
  const tokenVaultKey = `EIDAN_BLUESKY_TOKEN_${slug}`;

  // Seal the app password first; only record the account once the vault write has succeeded.
  if (!(await vaultPut(req, tokenVaultKey, appPassword))) {
    return Response.json({ error: "could not store the app password in the vault" }, { status: 502 });
  }

  let account: { id: string };
  try {
    account = await withUser(sess.userId, async (c) => {
      const ex = await c.query(
        `select id from plugin_social_bluesky.accounts
          where user_id = $1 and slug = $2 and status in ('active', 'pending')`,
        [sess.userId, slug],
      );
      const row = ex.rows[0] as { id: string } | undefined;
      if (row) {
        await c.query(
          `update plugin_social_bluesky.accounts
              set external_handle = $1, host = $2, token_vault_key = $3,
                  client_vault_key = '', refresh_vault_key = '', external_id = '',
                  status = 'active', updated_at = now()
            where id = $4 and user_id = $5`,
          [handle, service, tokenVaultKey, row.id, sess.userId],
        );
        return { id: row.id };
      }
      const r = await c.query(
        `insert into plugin_social_bluesky.accounts
           (user_id, name, slug, host, external_handle, external_id,
            client_vault_key, token_vault_key, refresh_vault_key, status)
         values ($1, $2, $3, $4, $5, '', '', $6, '', 'active')
         returning id`,
        [sess.userId, name, slug, service, handle, tokenVaultKey],
      );
      return r.rows[0] as { id: string };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_.*_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "you already have an account with that name" }, { status: 409 });
    }
    return Response.json({ error: "could not create account" }, { status: 500 });
  }

  return Response.json({ ok: true, handle, id: account.id });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const removed = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_social_bluesky.accounts set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status in ('active', 'pending')
        returning token_vault_key`,
      [id, sess.userId],
    );
    return r.rows[0] as Pick<AccountRow, "token_vault_key"> | undefined;
  });
  if (!removed) return Response.json({ error: "no such account" }, { status: 404 });
  await vaultDelete(req, removed.token_vault_key);
  return Response.json({ ok: true });
}
