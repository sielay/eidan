// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/finance-xero/accounts — the Connections admin data route for Xero (Next-reads-Postgres, Surface-B).
// Manages the operator's connected Xero organisations in plugin_finance_xero.accounts (the shared
// connections-kit schema) and seals the OAuth client id/secret + rotating tokens into the vault via the
// engine's secrets-api (the LLM-free write path). Owner-scoped; shipped in the plugin's frontend
// package, mounted under apps/web at deploy.
//   GET                                → { accounts: [{ id, name, slug, org, status }], redirect_uri }
//   POST { name, client_id, client_secret } → seal client, create a pending org, return the Xero consent URL.
//   POST { reconnect: <id> }           → re-run consent reusing the stored client (engine rebuilds the URL).
//   PUT  { code, state }               → finish connect: engine exchanges the code for tokens + tenant, seals them.
//   DELETE ?id=<id>                    → archive the row + remove its vault secrets
// Xero redirects the browser to the Callback page (/p/finance-xero/callback), which carries the bearer
// back here as a PUT (code → tokens, exchanged server-side by the engine), so the client secret never
// round-trips through the browser.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
// Granular read-only scopes (must mirror packages/finance-xero/src/adapter.ts). The broad
// accounting.transactions.read / accounting.reports.read are rejected unless toggled on in the Xero app.
const XERO_SCOPES = [
  "offline_access",
  "accounting.contacts.read",
  "accounting.settings.read",
  "accounting.invoices.read",
  "accounting.banktransactions.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.aged.read",
];

interface AccountRow {
  id: string;
  name: string;
  slug: string;
  org: string;
  status: string;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "org";
}

// The absolute redirect URI Xero calls back to — the Connections Callback page. Must be registered
// verbatim in the Xero developer portal. Derived from the public web origin so it works across deploys
// (override with EIDAN_PUBLIC_URL). MUST match between the consent URL and the code exchange, or Xero rejects.
function redirectUri(req: NextRequest): string {
  const base =
    process.env.EIDAN_PUBLIC_URL?.trim() ||
    process.env.EIDAN_WEB_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    req.nextUrl.origin;
  return `${base.replace(/\/+$/, "")}/p/finance-xero/callback`;
}

// Seal/replace a value in the vault via the engine's secrets-api, forwarding the caller's bearer. The
// engine encrypts it and scopes it to the user — the web never sees the master key.
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

// Forward an OAuth step to the engine's finance-xero oauth server (via the panel proxy), bearer-passed.
// The engine reads the sealed client from the write-only vault and runs consent / the code exchange.
async function engineOAuth(req: NextRequest, action: "start" | "finish", body: Record<string, unknown>): Promise<Response> {
  const engine = process.env.EIDAN_ENGINE_URL;
  const auth = req.headers.get("authorization");
  if (!engine || !auth) return Response.json({ error: "engine unavailable" }, { status: 502 });
  const r = await fetch(`${engine}/api/me/finance-xero/oauth/${action}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return Response.json(j, { status: r.status });
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const accounts = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, name, slug, external_handle as org, status
         from plugin_finance_xero.accounts
        where user_id = $1 and status in ('active', 'pending')
        order by created_at`,
      [sess.userId],
    );
    return r.rows as AccountRow[];
  });
  return Response.json({ accounts, redirect_uri: redirectUri(req) });
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

  // Reconnect: re-run consent for an existing org using its stored client — the engine reads the
  // write-only vault and rebuilds the consent URL, so nothing is re-entered.
  if (typeof body["reconnect"] === "string" && body["reconnect"]) {
    return engineOAuth(req, "start", { account_id: body["reconnect"], redirect_uri: redirectUri(req) });
  }

  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const clientId = typeof body["client_id"] === "string" ? body["client_id"].trim() : "";
  const clientSecret = typeof body["client_secret"] === "string" ? body["client_secret"].trim() : "";
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!clientId || !clientSecret) {
    return Response.json({ error: "client_id and client_secret are required" }, { status: 400 });
  }

  const slug = slugify(name);
  const clientVaultKey = `EIDAN_XERO_CLIENT_${slug}`;
  const tokenVaultKey = `EIDAN_XERO_TOKEN_${slug}`;
  const refreshVaultKey = `EIDAN_XERO_REFRESH_${slug}`;

  // Seal the operator's OAuth client first; only record the org once the vault write succeeds. The
  // packing shape ({ client_id, client_secret }) matches what the connections-kit `parseClient` reads.
  if (!(await vaultPut(req, clientVaultKey, JSON.stringify({ client_id: clientId, client_secret: clientSecret })))) {
    return Response.json({ error: "could not store the OAuth client in the vault" }, { status: 502 });
  }

  let account: { id: string };
  try {
    account = await withUser(sess.userId, async (c) => {
      const ex = await c.query(
        `select id from plugin_finance_xero.accounts
          where user_id = $1 and slug = $2 and status in ('active', 'pending')`,
        [sess.userId, slug],
      );
      const row = ex.rows[0] as { id: string } | undefined;
      if (row) {
        await c.query(
          `update plugin_finance_xero.accounts
              set client_vault_key = $1, token_vault_key = $2, refresh_vault_key = $3, status = 'pending', updated_at = now()
            where id = $4 and user_id = $5`,
          [clientVaultKey, tokenVaultKey, refreshVaultKey, row.id, sess.userId],
        );
        return { id: row.id };
      }
      const r = await c.query(
        `insert into plugin_finance_xero.accounts
           (user_id, name, slug, client_vault_key, token_vault_key, refresh_vault_key, status)
         values ($1, $2, $3, $4, $5, $6, 'pending')
         returning id`,
        [sess.userId, name, slug, clientVaultKey, tokenVaultKey, refreshVaultKey],
      );
      return r.rows[0] as { id: string };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_plugin_finance_xero_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "you already have an organisation with that name" }, { status: 409 });
    }
    return Response.json({ error: "could not create organisation" }, { status: 500 });
  }

  // The browser must now visit Xero's consent screen. `state` carries the pending org id so the callback
  // can find it, exchange the code, seal the tokens + tenant id, and flip the row to active.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: XERO_SCOPES.join(" "),
    state: account.id,
  });
  return Response.json({ ok: true, auth_url: `${XERO_AUTHORIZE_URL}?${params.toString()}` });
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
  const code = typeof body["code"] === "string" ? body["code"].trim() : "";
  const state = typeof body["state"] === "string" ? body["state"].trim() : "";
  if (!code || !state) return Response.json({ error: "code and state are required" }, { status: 400 });

  // Finish entirely server-side: the engine reads the OAuth client sealed in the write-only vault (under
  // this org's key), exchanges the code for access + refresh tokens, discovers the tenant via
  // /connections, seals the tokens, and flips the org to active. The client secret never touches the browser.
  return engineOAuth(req, "finish", { code, state, redirect_uri: redirectUri(req) });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const removed = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_finance_xero.accounts set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status in ('active', 'pending')
        returning client_vault_key, token_vault_key, refresh_vault_key`,
      [id, sess.userId],
    );
    return r.rows[0] as
      | { client_vault_key: string; token_vault_key: string; refresh_vault_key: string }
      | undefined;
  });
  if (!removed) return Response.json({ error: "no such organisation" }, { status: 404 });
  await vaultDelete(req, removed.client_vault_key);
  await vaultDelete(req, removed.token_vault_key);
  await vaultDelete(req, removed.refresh_vault_key);
  return Response.json({ ok: true });
}
