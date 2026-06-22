// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/logs/sources — the Log-sources admin data route (Next-reads-Postgres, the Surface-B pattern).
// Manages the operator's named log sources in plugin_logs.sources and seals each source's API token
// into the vault via the engine's secrets-api (the LLM-free write path). The non-secret config
// (provider + project/app/team or query endpoint) is stored in the registry; the token is never read
// back or returned. Owner-scoped; shipped in the bundle's frontend package, mounted under apps/web.
//   GET                                            → { sources: [{ id, name, provider, config, … (no token) }] }
//   POST   { name, provider, config, token }       → seal token + insert row
//   DELETE ?id=<id>                                → archive the row + remove its vault secret
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = ["vercel", "fly", "heroku", "betterstack"] as const;
type Provider = (typeof PROVIDERS)[number];

interface SourceView {
  id: string;
  name: string;
  slug: string;
  provider: string;
  config: Record<string, unknown>;
}

const SOURCE_COLUMNS = "id, name, slug, provider, config";

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "source";
}

function tokenKey(slug: string): string {
  return `EIDAN_LOG_TOKEN_${slug}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Accept config as either a parsed object or a JSON string from the form; reject anything else.
function parseConfig(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
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
  if (!engine || !auth) return;
  await fetch(`${engine}/api/me/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { authorization: auth },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const sources = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select ${SOURCE_COLUMNS}
         from plugin_logs.sources
        where user_id = $1 and status = 'active'
        order by created_at`,
      [sess.userId],
    );
    return r.rows as SourceView[];
  });
  return Response.json({ sources });
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

  const name = str(body["name"]);
  const provider = str(body["provider"]) as Provider;
  const token = typeof body["token"] === "string" ? body["token"] : "";

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!PROVIDERS.includes(provider)) {
    return Response.json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` }, { status: 400 });
  }
  const config = parseConfig(body["config"]);
  if (config === null) return Response.json({ error: "config must be a JSON object" }, { status: 400 });

  const slug = slugify(name);
  const key = tokenKey(slug);

  // Seal the token first (when given); only record the source once the vault write succeeds.
  if (token) {
    if (!(await vaultPut(req, key, token))) {
      return Response.json({ error: "could not store the API token in the vault" }, { status: 502 });
    }
  }

  try {
    const source = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `insert into plugin_logs.sources (user_id, name, slug, provider, config, token_key)
         values ($1,$2,$3,$4,$5::jsonb,$6)
         returning ${SOURCE_COLUMNS}`,
        [sess.userId, name, slug, provider, JSON.stringify(config), token ? key : ""],
      );
      return r.rows[0] as SourceView;
    });
    return Response.json({ ok: true, source });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_logs_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "you already have a log source with that name" }, { status: 409 });
    }
    return Response.json({ error: "could not create log source" }, { status: 500 });
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

  const id = str(body["id"]);
  const name = str(body["name"]);
  const provider = str(body["provider"]) as Provider;
  const token = typeof body["token"] === "string" ? body["token"] : "";

  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!PROVIDERS.includes(provider)) {
    return Response.json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` }, { status: 400 });
  }
  const config = parseConfig(body["config"]);
  if (config === null) return Response.json({ error: "config must be a JSON object" }, { status: 400 });

  // The slug / vault key are frozen at creation, so a rename never orphans the sealed token.
  const existing = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select token_key, slug from plugin_logs.sources where id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    return r.rows[0] as { token_key: string; slug: string } | undefined;
  });
  if (!existing) return Response.json({ error: "no such source" }, { status: 404 });

  // Re-seal only when a new token was entered; blank keeps the current sealed one.
  let tokenKeyToStore = existing.token_key;
  if (token) {
    const key = existing.token_key || tokenKey(existing.slug);
    if (!(await vaultPut(req, key, token))) {
      return Response.json({ error: "could not store the API token in the vault" }, { status: 502 });
    }
    tokenKeyToStore = key;
  }

  const source = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_logs.sources
          set name=$3, provider=$4, config=$5::jsonb, token_key=$6, updated_at=now()
        where id=$1 and user_id=$2 and status='active'
        returning ${SOURCE_COLUMNS}`,
      [id, sess.userId, name, provider, JSON.stringify(config), tokenKeyToStore],
    );
    return r.rows[0] as SourceView;
  });
  return Response.json({ ok: true, source });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const removed = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_logs.sources set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status = 'active'
        returning token_key`,
      [id, sess.userId],
    );
    return r.rows[0] as { token_key: string } | undefined;
  });
  if (!removed) return Response.json({ error: "no such source" }, { status: 404 });
  if (removed.token_key) await vaultDelete(req, removed.token_key);
  return Response.json({ ok: true });
}
