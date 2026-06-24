// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface RegistrarAccountRow {
  id: string;
  registrar: string;
  name: string;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const payload = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, registrar, name from plugin_charles_domains.registrar_accounts
        where user_id = $1 and status = 'active'
        order by created_at`,
      [sess.userId],
    );
    const accounts = (r.rows as RegistrarAccountRow[]).map((row) => ({
      id: row.id,
      registrar: row.registrar,
      name: row.name,
    }));
    return { accounts };
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

  const action = String(body["action"] ?? "").trim();

  if (action === "connect") {
    const registrar = typeof body["registrar"] === "string" ? body["registrar"].trim() : "";
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    const apiKey = typeof body["api_key"] === "string" ? body["api_key"] : "";
    const apiSecret = typeof body["api_secret"] === "string" ? body["api_secret"] : "";

    if (!registrar || !name || !apiKey || !apiSecret) {
      return Response.json({ error: "registrar, name, api_key, and api_secret are required" }, { status: 400 });
    }

    if (!["godaddy", "cyberfolks"].includes(registrar)) {
      return Response.json({ error: "invalid registrar" }, { status: 400 });
    }

    try {
      const vaultKey = `EIDAN_DOMAINS_${registrar.toUpperCase()}_${name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
      const creds = JSON.stringify({ key: apiKey, secret: apiSecret });

      // Seal credentials in vault via engine secrets API
      const secretsUrl = new URL(process.env.EIDAN_ENGINE_URL ?? "http://localhost:8091");
      secretsUrl.pathname = "/api/me/secrets/" + encodeURIComponent(vaultKey);
      const secretsRes = await fetch(secretsUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: req.headers.get("authorization") ?? "",
        },
        body: JSON.stringify({ value: creds }),
      });

      if (!secretsRes.ok) {
        return Response.json({ error: "failed to seal credentials in vault" }, { status: 502 });
      }

      const account = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `insert into plugin_charles_domains.registrar_accounts (user_id, registrar, name, key_vault_key)
           values ($1, $2, $3, $4)
           returning id, registrar, name`,
          [sess.userId, registrar, name, vaultKey],
        );
        return r.rows[0] as RegistrarAccountRow;
      });

      return Response.json({ ok: true, account }, { status: 201 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique/i.test(msg)) {
        return Response.json({ error: "account already exists for this registrar" }, { status: 409 });
      }
      return Response.json({ error: `failed to connect registrar: ${msg}` }, { status: 500 });
    }
  } else if (action === "import") {
    const accountId = typeof body["account_id"] === "string" ? body["account_id"].trim() : "";
    if (!accountId) return Response.json({ error: "account_id is required" }, { status: 400 });

    try {
      const account = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `select id, registrar, name, key_vault_key from plugin_charles_domains.registrar_accounts
            where id = $1 and user_id = $2 and status = 'active'`,
          [accountId, sess.userId],
        );
        return r.rows[0] as {
          id: string;
          registrar: string;
          name: string;
          key_vault_key: string;
        } | undefined;
      });

      if (!account) {
        return Response.json({ error: "account not found" }, { status: 404 });
      }

      // Run the import on the engine (behind PanelProxy): it reads the sealed registrar key from the
      // vault — which the web can never decrypt — and calls the registrar API under the caller's
      // principal. See packages/charles-domains/src/import-server.ts.
      const engineUrl = new URL(process.env.EIDAN_ENGINE_URL || "http://localhost:8090");
      engineUrl.pathname = "/api/me/charles-domains/import";

      const engineRes = await fetch(engineUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: req.headers.get("authorization") || "",
        },
        body: JSON.stringify({ account_id: accountId }),
      });

      if (!engineRes.ok) {
        return Response.json(
          { error: "import failed (engine unreachable or error)" },
          { status: 502 }
        );
      }

      const result = (await engineRes.json()) as {
        ok: boolean;
        imported?: number;
        updated?: number;
        error?: string;
      };

      if (result.ok) {
        return Response.json({
          ok: true,
          imported: result.imported ?? 0,
          updated: result.updated ?? 0,
        });
      } else {
        return Response.json(
          { error: result.error ?? "import failed" },
          { status: 502 }
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `import failed: ${msg}` }, { status: 500 });
    }
  } else {
    return Response.json({ error: "action must be 'connect' or 'import'" }, { status: 400 });
  }
}
