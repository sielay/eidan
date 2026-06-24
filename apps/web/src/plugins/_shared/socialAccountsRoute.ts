// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared Connections admin data route for the OAuth-based social plugins (X, LinkedIn, Facebook,
// Instagram, Threads, YouTube, Mastodon). Next-reads-Postgres (Surface-B): manages the operator's
// connected accounts in plugin_<schema>.accounts and seals OAuth credentials into the vault via the
// engine's secrets-api (the LLM-free write path). Owner-scoped. Each plugin ships a 6-line
// frontend/api/route.ts that calls makeSocialAccountsRoute(config) and re-exports the handlers.
//
// The consent URL + code exchange are always driven by the ENGINE oauth server (so a PKCE verifier
// can be generated/kept and a reconnect can reuse the write-only sealed client). This route only
// seals the client, upserts the pending row, and proxies start/finish.
//
// Bluesky (app-password, no OAuth) ships its OWN route, not this factory.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export type SocialFlavor = "oauth2" | "oauth2_pkce" | "dynamic_app";

export interface SocialRouteConfig {
  name: string; // url name, e.g. 'social-x' (=> /p/social-x, /api/social-x/accounts, /api/me/social-x/oauth)
  provider: string; // vault-key provider, e.g. 'x'
  schema: string; // postgres schema, e.g. 'plugin_social_x'
  flavor: SocialFlavor;
  hasHost?: boolean; // mastodon: an instance host per account, composite (user_id, host, slug) uniqueness
}

function slugify(name: string): string {
  // ReDoS-free trim: a run of non-alnum already collapses to a single '_', so trimming one leading and
  // one trailing '_' (anchored, no '+') suffices and can't backtrack (avoids /^_+|_+$/ polynomial).
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_/, "").replace(/_$/, "").slice(0, 40);
  return s || "account";
}
function normHost(host: string): string {
  return host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
function provKey(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

interface AccountRow {
  id: string;
  name: string;
  slug: string;
  host: string;
  external_handle: string;
  status: string;
  token_expires_at: string | null;
  client_vault_key: string;
  token_vault_key: string;
  refresh_vault_key: string;
}

export function makeSocialAccountsRoute(cfg: SocialRouteConfig): {
  GET: (req: NextRequest) => Promise<Response>;
  POST: (req: NextRequest) => Promise<Response>;
  PUT: (req: NextRequest) => Promise<Response>;
  DELETE: (req: NextRequest) => Promise<Response>;
} {
  const P = provKey(cfg.provider);
  const oauthPrefix = `/api/me/${cfg.name}/oauth`;

  const redirectUri = (req: NextRequest): string => {
    const base =
      process.env.EIDAN_PUBLIC_URL?.trim() ||
      process.env.EIDAN_WEB_URL?.trim() ||
      process.env.NEXT_PUBLIC_APP_URL?.trim() ||
      req.nextUrl.origin;
    return `${base.replace(/\/+$/, "")}/p/${cfg.name}/callback`;
  };

  const vaultPut = async (req: NextRequest, key: string, value: string): Promise<boolean> => {
    const engine = process.env.EIDAN_ENGINE_URL;
    const auth = req.headers.get("authorization");
    if (!engine || !auth) return false;
    const r = await fetch(`${engine}/api/me/secrets/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    return r.ok;
  };

  const vaultDelete = async (req: NextRequest, key: string): Promise<void> => {
    const engine = process.env.EIDAN_ENGINE_URL;
    const auth = req.headers.get("authorization");
    if (!engine || !auth || !key) return;
    await fetch(`${engine}/api/me/secrets/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { authorization: auth },
    });
  };

  // Named OAuth apps: a user can register MANY client-credential sets per provider (e.g. personal +
  // work), and each connection picks one. The id/secret are sealed under a name-derived vault key; the
  // <schema>.apps table names them. (dynamic_app/mastodon registers a client per host — no app picker.)
  const usesApps = cfg.flavor === "oauth2" || cfg.flavor === "oauth2_pkce";
  const appVaultKey = (appName: string): string => `EIDAN_${P}_APP_${slugify(appName)}`;

  const engineOAuth = async (
    req: NextRequest,
    action: "start" | "finish" | "test" | "targets",
    body: Record<string, unknown>,
  ): Promise<Response> => {
    const engine = process.env.EIDAN_ENGINE_URL;
    const auth = req.headers.get("authorization");
    if (!engine || !auth) return Response.json({ error: "engine unavailable" }, { status: 502 });
    const r = await fetch(`${engine}${oauthPrefix}/${action}`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json(j, { status: r.status });
  };

  const GET = async (req: NextRequest): Promise<Response> => {
    const sess = verifyBearer(req);
    if (!sess) return new Response("unauthorized", { status: 401 });
    const { accounts, apps } = await withUser(sess.userId, async (c) => {
      // Accounts, with the name of the app each one uses (matched by the shared client_vault_key).
      const ar = await c.query(
        `select a.id, a.name, a.slug, a.host, a.external_handle, a.status, a.token_expires_at, a.context,
                a.metadata->>'type' as conn_type, ap.name as app_name
           from ${cfg.schema}.accounts a
           left join ${cfg.schema}.apps ap
             on ap.user_id = a.user_id and ap.client_vault_key = a.client_vault_key and ap.status = 'active'
          where a.user_id = $1 and a.status in ('active', 'pending')
          order by a.created_at`,
        [sess.userId],
      );
      const pr = usesApps
        ? await c.query(
            `select id, name, type from ${cfg.schema}.apps where user_id = $1 and status = 'active' order by created_at`,
            [sess.userId],
          )
        : { rows: [] as Array<{ id: string; name: string; type: string }> };
      return { accounts: ar.rows, apps: pr.rows as Array<{ id: string; name: string; type: string }> };
    });
    return Response.json({ accounts, apps, redirect_uri: redirectUri(req), flavor: cfg.flavor });
  };

  const POST = async (req: NextRequest): Promise<Response> => {
    const sess = verifyBearer(req);
    if (!sess) return new Response("unauthorized", { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    // Register a NEW named OAuth app (client id/secret) for this provider.
    if (body["create_app"] && typeof body["create_app"] === "object") {
      if (!usesApps) return Response.json({ error: "this provider has no OAuth apps" }, { status: 400 });
      const app = body["create_app"] as Record<string, unknown>;
      const appName = typeof app["name"] === "string" ? app["name"].trim() : "";
      const clientId = typeof app["client_id"] === "string" ? app["client_id"].trim() : "";
      const clientSecret = typeof app["client_secret"] === "string" ? app["client_secret"].trim() : "";
      // Optional per-app scope override (some providers gate scopes by the app's products) + an optional
      // app kind/type (e.g. LinkedIn member vs organization) that connections made with it inherit.
      const scopes = typeof app["scopes"] === "string" ? app["scopes"].trim() : "";
      const appType = typeof app["type"] === "string" ? app["type"].trim() : "";
      if (!appName) return Response.json({ error: "app name is required" }, { status: 400 });
      if (!clientId || !clientSecret) return Response.json({ error: "client_id and client_secret are required" }, { status: 400 });
      const key = appVaultKey(appName);
      const sealed = JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...(scopes ? { scopes } : {}) });
      if (!(await vaultPut(req, key, sealed))) {
        return Response.json({ error: "could not store the OAuth app in the vault" }, { status: 502 });
      }
      try {
        const id = await withUser(sess.userId, async (c) => {
          const r = await c.query(
            `insert into ${cfg.schema}.apps (user_id, name, type, client_vault_key, status)
             values ($1, $2, $3, $4, 'active') returning id`,
            [sess.userId, appName, appType, key],
          );
          return (r.rows[0] as { id: string }).id;
        });
        return Response.json({ ok: true, id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/uq_.*_app_name|duplicate key/i.test(msg)) {
          return Response.json({ error: "you already have an app with that name" }, { status: 409 });
        }
        return Response.json({ error: "could not create app" }, { status: 500 });
      }
    }

    // Edit an existing app: reseal its client (id/secret must be re-entered — the secret is never read
    // back) with new scopes, and update its kind/type. The client_vault_key (name-derived) is kept, so
    // connections already pointing at it pick up the new scopes/type on their next (re)connect.
    if (body["update_app"] && typeof body["update_app"] === "object") {
      if (!usesApps) return Response.json({ error: "this provider has no OAuth apps" }, { status: 400 });
      const u = body["update_app"] as Record<string, unknown>;
      const id = typeof u["id"] === "string" ? u["id"] : "";
      const clientId = typeof u["client_id"] === "string" ? u["client_id"].trim() : "";
      const clientSecret = typeof u["client_secret"] === "string" ? u["client_secret"].trim() : "";
      const scopes = typeof u["scopes"] === "string" ? u["scopes"].trim() : "";
      const appType = typeof u["type"] === "string" ? u["type"].trim() : "";
      if (!id) return Response.json({ error: "id is required" }, { status: 400 });
      if (!clientId || !clientSecret) {
        return Response.json({ error: "re-enter the client ID + secret to update an app" }, { status: 400 });
      }
      const app = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `select client_vault_key from ${cfg.schema}.apps where id = $1 and user_id = $2 and status = 'active'`,
          [id, sess.userId],
        );
        return r.rows[0] as { client_vault_key: string } | undefined;
      });
      if (!app) return Response.json({ error: "no such app" }, { status: 404 });
      const sealed = JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...(scopes ? { scopes } : {}) });
      if (!(await vaultPut(req, app.client_vault_key, sealed))) {
        return Response.json({ error: "could not store the OAuth app in the vault" }, { status: 502 });
      }
      await withUser(sess.userId, async (c) => {
        await c.query(`update ${cfg.schema}.apps set type = $3, updated_at = now() where id = $1 and user_id = $2`, [
          id,
          sess.userId,
          appType,
        ]);
      });
      return Response.json({ ok: true });
    }

    // Delete a named OAuth app. Blocked only by a LIVE (active) connection; a failed/in-flight
    // (pending) connection that never completed is archived alongside so a bad app can be replaced.
    if (typeof body["delete_app"] === "string" && body["delete_app"]) {
      const appId = body["delete_app"];
      const result = await withUser(sess.userId, async (c) => {
        const ar = await c.query(
          `select client_vault_key from ${cfg.schema}.apps where id = $1 and user_id = $2 and status = 'active'`,
          [appId, sess.userId],
        );
        const app = ar.rows[0] as { client_vault_key: string } | undefined;
        if (!app) return { code: 404 as const };
        const used = await c.query(
          `select 1 from ${cfg.schema}.accounts
            where user_id = $1 and client_vault_key = $2 and status = 'active' limit 1`,
          [sess.userId, app.client_vault_key],
        );
        if (used.rows.length) return { code: 409 as const };
        // Clear away any pending (never-completed) connections that referenced this app.
        await c.query(
          `update ${cfg.schema}.accounts set status = 'archived', updated_at = now()
            where user_id = $1 and client_vault_key = $2 and status = 'pending'`,
          [sess.userId, app.client_vault_key],
        );
        await c.query(`update ${cfg.schema}.apps set status = 'archived', updated_at = now() where id = $1 and user_id = $2`, [appId, sess.userId]);
        return { code: 200 as const, key: app.client_vault_key };
      });
      if (result.code === 404) return Response.json({ error: "no such app" }, { status: 404 });
      if (result.code === 409) return Response.json({ error: "this app is still used by a connection — disconnect those first" }, { status: 409 });
      await vaultDelete(req, result.key);
      return Response.json({ ok: true });
    }

    // Rename a connection and/or set its agent-facing context (the slug + vault keys stay put).
    if (body["update"] && typeof body["update"] === "object") {
      const u = body["update"] as Record<string, unknown>;
      const id = typeof u["id"] === "string" ? u["id"] : "";
      if (!id) return Response.json({ error: "id is required" }, { status: 400 });
      const newName = typeof u["name"] === "string" ? u["name"].trim() : null;
      const newContext = typeof u["context"] === "string" ? u["context"] : null;
      const ok = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `update ${cfg.schema}.accounts
              set name = coalesce($3, name), context = coalesce($4, context), updated_at = now()
            where id = $1 and user_id = $2 and status in ('active', 'pending')`,
          [id, sess.userId, newName, newContext],
        );
        return (r.rowCount ?? 0) > 0;
      });
      return ok ? Response.json({ ok: true }) : Response.json({ error: "no such account" }, { status: 404 });
    }

    // Test: probe the connection live (engine resolves the token + calls the platform).
    if (typeof body["test"] === "string" && body["test"]) {
      return engineOAuth(req, "test", { account_id: body["test"] });
    }

    // List the sub-targets (e.g. LinkedIn Pages) this connection's token can act as, for a picker.
    if (typeof body["list_targets"] === "string" && body["list_targets"]) {
      return engineOAuth(req, "targets", { account_id: body["list_targets"] });
    }

    // Bind a connection to a chosen target (id = the canonical target, e.g. an org URN; label shown).
    if (body["set_target"] && typeof body["set_target"] === "object") {
      const s = body["set_target"] as Record<string, unknown>;
      const id = typeof s["id"] === "string" ? s["id"] : "";
      const targetId = typeof s["target"] === "string" ? s["target"] : "";
      const label = typeof s["label"] === "string" ? s["label"] : "";
      if (!id || !targetId) return Response.json({ error: "id and target are required" }, { status: 400 });
      const ok = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `update ${cfg.schema}.accounts
              set external_id = $3, external_handle = $4,
                  metadata = metadata || jsonb_build_object('target', $3::text), updated_at = now()
            where id = $1 and user_id = $2 and status in ('active', 'pending')`,
          [id, sess.userId, targetId, label],
        );
        return (r.rowCount ?? 0) > 0;
      });
      return ok ? Response.json({ ok: true }) : Response.json({ error: "no such account" }, { status: 404 });
    }

    // Reconnect: re-run consent for an existing account reusing its sealed client (engine-driven).
    if (typeof body["reconnect"] === "string" && body["reconnect"]) {
      return engineOAuth(req, "start", { account_id: body["reconnect"], redirect_uri: redirectUri(req) });
    }

    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (!name) return Response.json({ error: "name is required" }, { status: 400 });
    const host = cfg.hasHost ? normHost(typeof body["host"] === "string" ? body["host"] : "") : "";
    if (cfg.hasHost && !host) return Response.json({ error: "host (instance) is required" }, { status: 400 });
    // A connection inherits its type from the app it's made with (e.g. LinkedIn member vs
    // organization) — stored in metadata.type so the engine probes/behaves accordingly. Resolved from
    // the chosen app below.
    let connType = "";

    const slug = slugify(name);
    const tokenVaultKey = `EIDAN_${P}_TOKEN_${slug}`;
    const refreshVaultKey = `EIDAN_${P}_REFRESH_${slug}`;
    // The client comes from a SHARED app: dynamic_app (mastodon) registers a client per host; every
    // other OAuth provider requires the operator to pick one of their named apps (which authorises this
    // connection). Connecting without choosing an app is rejected.
    let clientVaultKey: string;
    if (cfg.flavor === "dynamic_app") {
      clientVaultKey = `EIDAN_${P}_HOSTAPP_${slugify(host)}`;
    } else {
      const appId = typeof body["app_id"] === "string" ? body["app_id"].trim() : "";
      if (!appId) return Response.json({ error: "choose an OAuth app to connect with" }, { status: 400 });
      const app = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `select client_vault_key, type from ${cfg.schema}.apps where id = $1 and user_id = $2 and status = 'active'`,
          [appId, sess.userId],
        );
        return r.rows[0] as { client_vault_key: string; type: string } | undefined;
      });
      if (!app) return Response.json({ error: "unknown OAuth app — add one first" }, { status: 400 });
      clientVaultKey = app.client_vault_key;
      connType = app.type ?? "";
    }
    // Optional per-connection target (e.g. which LinkedIn Page/organization this connection is for).
    const connTarget = typeof body["target"] === "string" ? body["target"].trim() : "";
    const meta: Record<string, string> = {};
    if (connType) meta["type"] = connType;
    if (connTarget) meta["target"] = connTarget;
    const metaJson = JSON.stringify(meta);

    let account: { id: string };
    try {
      account = await withUser(sess.userId, async (c) => {
        const ex = await c.query(
          `select id from ${cfg.schema}.accounts
            where user_id = $1 and slug = $2 ${cfg.hasHost ? "and host = $3" : ""}
              and status in ('active', 'pending')`,
          cfg.hasHost ? [sess.userId, slug, host] : [sess.userId, slug],
        );
        const row = ex.rows[0] as { id: string } | undefined;
        if (row) {
          await c.query(
            `update ${cfg.schema}.accounts
                set client_vault_key = $1, token_vault_key = $2, refresh_vault_key = $3,
                    host = $4, metadata = metadata || $7::jsonb, status = 'pending', updated_at = now()
              where id = $5 and user_id = $6`,
            [clientVaultKey, tokenVaultKey, refreshVaultKey, host, row.id, sess.userId, metaJson],
          );
          return { id: row.id };
        }
        const r = await c.query(
          `insert into ${cfg.schema}.accounts
             (user_id, name, slug, host, client_vault_key, token_vault_key, refresh_vault_key, status, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb)
           returning id`,
          [sess.userId, name, slug, host, clientVaultKey, tokenVaultKey, refreshVaultKey, metaJson],
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

    // Engine builds the consent URL (generates/keeps a PKCE verifier; registers a per-host app for
    // mastodon), reusing the sealed client. The browser then visits it.
    return engineOAuth(req, "start", { account_id: account.id, redirect_uri: redirectUri(req) });
  };

  const PUT = async (req: NextRequest): Promise<Response> => {
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
    return engineOAuth(req, "finish", { code, state, redirect_uri: redirectUri(req) });
  };

  const DELETE = async (req: NextRequest): Promise<Response> => {
    const sess = verifyBearer(req);
    if (!sess) return new Response("unauthorized", { status: 401 });
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });

    const removed = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `update ${cfg.schema}.accounts set status = 'archived', updated_at = now()
          where id = $1 and user_id = $2 and status in ('active', 'pending')
          returning client_vault_key, token_vault_key, refresh_vault_key`,
        [id, sess.userId],
      );
      return r.rows[0] as
        | Pick<AccountRow, "client_vault_key" | "token_vault_key" | "refresh_vault_key">
        | undefined;
    });
    if (!removed) return Response.json({ error: "no such account" }, { status: 404 });
    // The client is ALWAYS shared (per-provider app, or per-host app for mastodon) — never delete it on
    // a single account removal; other accounts (and future re-adds) rely on it. Only drop the tokens.
    await vaultDelete(req, removed.token_vault_key);
    await vaultDelete(req, removed.refresh_vault_key);
    return Response.json({ ok: true });
  };

  return { GET, POST, PUT, DELETE };
}
