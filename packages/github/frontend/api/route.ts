// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/github/accounts — the Connections admin data route for GitHub (Next-reads-Postgres, Surface-B).
// GitHub has NO OAuth for PATs: the user pastes a Personal Access Token, so this route is custom
// (it does NOT use the shared makeSocialAccountsRoute factory, which is for OAuth flavours). It seals
// the PAT into the vault via the engine's secrets-api (the LLM-free write path) and records an ACTIVE
// account in plugin_github.accounts — there is no consent redirect, so the connection completes
// synchronously. Owner-scoped; shipped in the bundle's frontend package, mounted under apps/web at deploy.
// The tokenVaultKey is stable per account (derived from account ID, not user-provided name), so name
// changes don't orphan secrets or collide with other users' accounts.
//   GET                                   → { accounts: [...] }
//   POST { name, pat }                    → seal the PAT, test it, upsert an active account
//   POST { test: id }                     → probe the connection live (engine calls GitHub)
//   POST { update: { id, name, context } } → rename + set context (no vault key change)
//   DELETE ?id=<id>                       → archive the row + remove its vault secret
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AccountRow {
  id: string;
  name: string;
  slug: string;
  external_handle: string;
  status: string;
  token_expires_at: string | null;
  token_vault_key: string;
  context: string;
  metadata: Record<string, unknown>;
}

// Connection scope (stored under metadata.scope): read vs write, and an org/repo allowlist (patterns
// like "owner/*", "owner/name", "owner/name*"; a bare "owner" means the whole org).
function parseScopeInput(body: Record<string, unknown>): { access: "read" | "write"; allow: string[] } {
  const access = body["access"] === "write" ? "write" : "read";
  const raw = body["allow"];
  const allow = Array.isArray(raw)
    ? raw.map((x) => String(x).trim()).filter(Boolean)
    : typeof raw === "string"
      ? raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
      : [];
  return { access, allow };
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // Remove combining diacritical marks (handles é, ñ, etc.)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_/, "")
    .replace(/_$/, "")
    .slice(0, 40);
  return s || "account";
}

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
      `select id, name, slug, external_handle, status, token_expires_at, context, metadata
         from plugin_github.accounts
        where user_id = $1 and status in ('active', 'pending')
        order by created_at`,
      [sess.userId],
    );
    return r.rows as Pick<
      AccountRow,
      "id" | "name" | "slug" | "external_handle" | "status" | "token_expires_at" | "context" | "metadata"
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

  // Rename a connection and/or set its agent-facing context (slug + sealed PAT stay put).
  if (body["update"] && typeof body["update"] === "object") {
    const u = body["update"] as Record<string, unknown>;
    const id = typeof u["id"] === "string" ? u["id"] : "";
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    const newName = typeof u["name"] === "string" ? u["name"].trim() : null;
    const newContext = typeof u["context"] === "string" ? u["context"] : null;
    const scopeJson = ("access" in u || "allow" in u) ? JSON.stringify(parseScopeInput(u)) : null;
    const ok = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `update plugin_github.accounts
            set name = coalesce($3, name), context = coalesce($4, context),
                metadata = case when $5::jsonb is null then metadata
                                else jsonb_set(coalesce(metadata, '{}'::jsonb), '{scope}', $5::jsonb, true) end,
                updated_at = now()
          where id = $1 and user_id = $2 and status in ('active', 'pending')`,
        [id, sess.userId, newName, newContext, scopeJson],
      );
      return (r.rowCount ?? 0) > 0;
    });
    return ok ? Response.json({ ok: true }) : Response.json({ error: "no such account" }, { status: 404 });
  }

  // Test: probe the connection live (engine calls GitHub to verify the PAT).
  if (typeof body["test"] === "string" && body["test"]) {
    const engine = process.env.EIDAN_ENGINE_URL;
    const auth = req.headers.get("authorization");
    if (!engine || !auth) return Response.json({ error: "engine unavailable" }, { status: 502 });
    const r = await fetch(`${engine}/api/me/github/oauth/test`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ account_id: body["test"] }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json(j, { status: r.status });
  }

  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const pat = typeof body["pat"] === "string" ? body["pat"].trim() : "";
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!pat) return Response.json({ error: "pat is required" }, { status: 400 });

  const slug = slugify(name);
  const scope = parseScopeInput(body);
  const scopeMeta = JSON.stringify({ scope }); // full metadata object for a new row
  const scopeVal = JSON.stringify(scope); // just the scope value for jsonb_set on an existing row

  let account: { id: string; handle: string; externalId: string };
  try {
    // Test the PAT against GitHub API to get the login (handle) and ID.
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${pat}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "eidan-github-plugin",
      },
    });

    if (!userRes.ok) {
      const data = (await userRes.json().catch(() => ({}))) as { message?: string };
      const msg = data.message ?? "Failed to verify PAT";
      return Response.json({ error: msg }, { status: 401 });
    }

    const userData = (await userRes.json()) as { login?: string; id?: number };
    const handle = userData.login ?? "";
    const ghId = userData.id ?? 0;
    if (!handle || !ghId) {
      return Response.json({ error: "Could not determine GitHub login or ID from PAT" }, { status: 400 });
    }

    account = await withUser(sess.userId, async (c) => {
      // Check if we already have an account with this slug (same user-provided name).
      const ex = await c.query(
        `select id, token_vault_key from plugin_github.accounts
          where user_id = $1 and slug = $2 and status in ('active', 'pending')`,
        [sess.userId, slug],
      );
      const row = ex.rows[0] as { id: string; token_vault_key: string } | undefined;
      if (row) {
        // Reuse existing account: update handle/ID, seal new PAT, keep vault key stable.
        const tokenVaultKey = row.token_vault_key;
        if (!(await vaultPut(req, tokenVaultKey, pat))) {
          throw new Error("could not store the PAT in the vault");
        }
        await c.query(
          `update plugin_github.accounts
              set external_handle = $1, external_id = $2,
                  client_vault_key = '', refresh_vault_key = '',
                  metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{scope}', $5::jsonb, true),
                  status = 'active', updated_at = now()
            where id = $3 and user_id = $4`,
          [handle, String(ghId), row.id, sess.userId, scopeVal],
        );
        return { id: row.id, handle, externalId: String(ghId) };
      }

      // New account: generate stable ID-based vault key, insert row.
      const newId = await c.query(`select gen_random_uuid() as id`);
      const accountId = (newId.rows[0] as { id: string }).id;
      const tokenVaultKey = `EIDAN_GITHUB_TOKEN_${sess.userId}_${accountId}`;

      // Seal the PAT first; only record the account once the vault write has succeeded.
      if (!(await vaultPut(req, tokenVaultKey, pat))) {
        throw new Error("could not store the PAT in the vault");
      }

      const r = await c.query(
        `insert into plugin_github.accounts
           (id, user_id, name, slug, host, external_handle, external_id,
            client_vault_key, token_vault_key, refresh_vault_key, status, metadata)
         values ($1, $2, $3, $4, '', $5, $6, '', $7, '', 'active', $8::jsonb)
         returning id`,
        [accountId, sess.userId, name, slug, handle, String(ghId), tokenVaultKey, scopeMeta],
      );
      return { id: (r.rows[0] as { id: string }).id, handle, externalId: String(ghId) };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_.*_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "you already have an account with that name" }, { status: 409 });
    }
    if (msg === "could not store the PAT in the vault") {
      return Response.json({ error: msg }, { status: 502 });
    }
    return Response.json({ error: "could not create account" }, { status: 500 });
  }

  return Response.json({ ok: true, handle: account.handle, id: account.id });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const removed = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_github.accounts set status = 'archived', updated_at = now()
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
