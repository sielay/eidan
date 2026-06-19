// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/google/accounts — the Connections admin data route for Gmail (Next-reads-Postgres, Surface-B).
// Manages the operator's connected Gmail accounts in plugin_google.accounts and seals the OAuth
// client id/secret + refresh token into the vault via the engine's secrets-api (the LLM-free write
// path). Owner-scoped; shipped in the bundle's frontend package, mounted under apps/web at deploy.
//   GET                                → { accounts: [{ id, name, slug, email, status }] }
//   POST { name, client_id, client_secret } → seal client creds, create a pending account, return the
//                                            Google consent URL the browser must visit to finish.
//   PUT  { code, state }               → finish connect: exchange the code for a refresh token, seal
//                                        it, record the email, flip the pending account to active.
//   DELETE ?id=<id>                    → archive the row + remove its vault secrets
// Google redirects the browser to the Callback page (/p/google/callback), which carries the bearer
// back here as a PUT (code → refresh token), so all vault/db access stays bearer-authenticated like
// ical's. That page is a component route (it uses the host's authFetch), not an API route.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/drive.readonly", "openid", "email"];

interface AccountRow {
  id: string;
  name: string;
  slug: string;
  email: string;
  client_vault_key: string;
  refresh_vault_key: string;
  status: string;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "account";
}

// The absolute redirect URI Google calls back to — the Connections Callback page. Must be registered
// verbatim in Google Cloud Console → Credentials → OAuth client. Derived from the public web origin so
// it works across deploys (override with EIDAN_PUBLIC_URL when the request origin isn't externally
// reachable). MUST match between the consent URL (POST) and the code exchange (PUT), or Google rejects.
function redirectUri(req: NextRequest): string {
  // The public origin Google calls back to. Prefer EIDAN_WEB_URL — the deploy model's canonical public
  // URL, DERIVED by the wizard from the web (vercel) target's domain (deploy/manifest.mjs) and pushed
  // to Vercel, so a correctly-deployed instance needs no manual entry. EIDAN_PUBLIC_URL is an explicit
  // operator override; NEXT_PUBLIC_APP_URL is the legacy browser-bundle var. `?.trim() ||` treats a
  // blank value as unset (a key present-but-empty would, with `??`, leave base = "" and yield a
  // domain-less "/p/google/callback" that Google rejects). Falls back to the request origin.
  const base =
    process.env.EIDAN_PUBLIC_URL?.trim() ||
    process.env.EIDAN_WEB_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    req.nextUrl.origin;
  return `${base.replace(/\/+$/, "")}/p/google/callback`;
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

// Forward an OAuth step to the engine's google-oauth server (via the panel proxy), bearer-passed.
// Reconnect uses this: the engine reads the sealed client from the write-only vault and runs consent
// / the code exchange, so the operator re-enters nothing.
async function engineOAuth(req: NextRequest, action: "start" | "finish", body: Record<string, unknown>): Promise<Response> {
  const engine = process.env.EIDAN_ENGINE_URL;
  const auth = req.headers.get("authorization");
  if (!engine || !auth) return Response.json({ error: "engine unavailable" }, { status: 502 });
  const r = await fetch(`${engine}/api/me/google/oauth/${action}`, {
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
  // Include `pending` rows (an in-flight / failed connect) so the operator can see and remove a
  // connection that never completed — otherwise it stays invisible yet holds the name.
  const accounts = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, name, slug, email, status
         from plugin_google.accounts
        where user_id = $1 and status in ('active', 'pending')
        order by created_at`,
      [sess.userId],
    );
    return r.rows as Pick<AccountRow, "id" | "name" | "slug" | "email" | "status">[];
  });
  // Surface the exact callback URL the operator must register in Google Cloud Console.
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

  // Reconnect: re-run consent for an existing account using its stored client — the engine reads the
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
  const clientVaultKey = `EIDAN_GOOGLE_CLIENT_${slug}`;
  const refreshVaultKey = `EIDAN_GOOGLE_REFRESH_${slug}`;

  // Seal the operator's OAuth client id/secret first; only record the account once the vault write has
  // succeeded. The refresh token is sealed later by the callback, once consent completes.
  if (!(await vaultPut(req, clientVaultKey, JSON.stringify({ client_id: clientId, client_secret: clientSecret })))) {
    return Response.json({ error: "could not store the OAuth client in the vault" }, { status: 502 });
  }

  // Reuse an existing connection for this name (re-auth): re-seal the client, set it back to
  // `pending`, and restart consent. This covers BOTH retrying a failed connect AND re-authenticating
  // an active account — needed because Google expires refresh tokens after 7 days for unverified
  // (test-mode) apps, so an operator must periodically reconnect.
  let account: { id: string };
  try {
    account = await withUser(sess.userId, async (c) => {
      const ex = await c.query(
        `select id from plugin_google.accounts
          where user_id = $1 and slug = $2 and status in ('active', 'pending')`,
        [sess.userId, slug],
      );
      const row = ex.rows[0] as { id: string } | undefined;
      if (row) {
        await c.query(
          `update plugin_google.accounts
              set client_vault_key = $1, refresh_vault_key = $2, status = 'pending', updated_at = now()
            where id = $3 and user_id = $4`,
          [clientVaultKey, refreshVaultKey, row.id, sess.userId],
        );
        return { id: row.id };
      }
      const r = await c.query(
        `insert into plugin_google.accounts
           (user_id, name, slug, email, client_vault_key, refresh_vault_key, status)
         values ($1, $2, $3, '', $4, $5, 'pending')
         returning id`,
        [sess.userId, name, slug, clientVaultKey, refreshVaultKey],
      );
      return r.rows[0] as { id: string };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_google_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "you already have an account with that name" }, { status: 409 });
    }
    return Response.json({ error: "could not create account" }, { status: 500 });
  }

  // The browser must now visit Google's consent screen. `state` carries the pending account id so the
  // callback can find it, exchange the code, seal the refresh token, and flip the row to active.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(req),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GMAIL_SCOPES.join(" "),
    state: account.id,
  });
  return Response.json({ ok: true, auth_url: `${GOOGLE_AUTH_URL}?${params.toString()}` });
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

  // Reconnect path: the browser carries no client (it can't read the write-only vault). Hand off to
  // the engine, which reads the sealed client and finishes the exchange + seals the new token.
  const clientId = typeof body["client_id"] === "string" ? body["client_id"].trim() : "";
  const clientSecret = typeof body["client_secret"] === "string" ? body["client_secret"].trim() : "";
  if (!clientId || !clientSecret) {
    return engineOAuth(req, "finish", { code, state, redirect_uri: redirectUri(req) });
  }

  // Initial connect: the Callback page carried the client from sessionStorage — exchange it here.
  const acct = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, client_vault_key, refresh_vault_key
         from plugin_google.accounts
        where id = $1 and user_id = $2 and status = 'pending'`,
      [state, sess.userId],
    );
    return r.rows[0] as
      | { id: string; client_vault_key: string; refresh_vault_key: string }
      | undefined;
  });
  if (!acct) return Response.json({ error: "no pending connection for that state" }, { status: 404 });
  void acct.client_vault_key;

  // Exchange the auth code for a refresh token. access_type=offline + prompt=consent (set on the
  // consent URL) make Google return a refresh_token here.
  const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    return Response.json({ error: `Google rejected the code (HTTP ${tokenResp.status})` }, { status: 502 });
  }
  const tok = (await tokenResp.json()) as { refresh_token?: string; access_token?: string };
  if (!tok.refresh_token) {
    return Response.json(
      { error: "Google returned no refresh token — revoke the app under your Google account and reconnect" },
      { status: 502 },
    );
  }

  // Best-effort: discover which mailbox was connected, for the list chip.
  let email = "";
  if (tok.access_token) {
    try {
      const ui = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${tok.access_token}` } });
      if (ui.ok) email = ((await ui.json()) as { email?: string }).email ?? "";
    } catch {
      email = "";
    }
  }

  // Seal the refresh token, then flip the account to active. Tokens never go back to the browser.
  if (!(await vaultPut(req, acct.refresh_vault_key, tok.refresh_token))) {
    return Response.json({ error: "could not store the refresh token in the vault" }, { status: 502 });
  }
  await withUser(sess.userId, async (c) => {
    await c.query(
      `update plugin_google.accounts set status = 'active', email = $1, updated_at = now()
        where id = $2 and user_id = $3`,
      [email, acct.id, sess.userId],
    );
  });
  return Response.json({ ok: true, email });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const removed = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_google.accounts set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status in ('active', 'pending')
        returning client_vault_key, refresh_vault_key`,
      [id, sess.userId],
    );
    return r.rows[0] as { client_vault_key: string; refresh_vault_key: string } | undefined;
  });
  if (!removed) return Response.json({ error: "no such account" }, { status: 404 });
  await vaultDelete(req, removed.client_vault_key);
  await vaultDelete(req, removed.refresh_vault_key);
  return Response.json({ ok: true });
}
