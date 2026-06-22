// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/db/connections — the Databases admin data route (Next-reads-Postgres, the Surface-B pattern).
// Manages the operator's named database connections in plugin_db.connections and seals each
// connection's password into the vault via the engine's secrets-api (the LLM-free write path). The
// non-secret coordinates (driver/host/port/database/username/options) are stored in the registry;
// the password is never read back or returned. Owner-scoped; shipped in the bundle's frontend
// package, mounted under apps/web at deploy.
//   GET                                                  → { connections: [{ id, name, driver, … (no password) }] }
//   POST   { name, driver, host, port, database, username, password, options } → seal password + insert row
//   DELETE ?id=<id>                                      → archive the row + remove its vault secret
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DRIVERS = ["postgres", "mongodb"] as const;
type Driver = (typeof DRIVERS)[number];

const DEFAULT_PORT: Record<Driver, number> = { postgres: 5432, mongodb: 27017 };

// Non-secret view of a connection — what the UI lists. The password (and its vault key) are omitted.
interface ConnectionView {
  id: string;
  name: string;
  slug: string;
  driver: string;
  host: string;
  port: number;
  database: string;
  username: string;
  options: Record<string, unknown>;
}

const CONNECTION_COLUMNS = "id, name, slug, driver, host, port, database, username, options";

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "connection";
}

function passKey(slug: string): string {
  return `EIDAN_DB_PASS_${slug}`;
}

function port(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Accept options as either a parsed object or a JSON string from the form; reject anything else.
function parseOptions(value: unknown): Record<string, unknown> | null {
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
  const connections = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select ${CONNECTION_COLUMNS}
         from plugin_db.connections
        where user_id = $1 and status = 'active'
        order by created_at`,
      [sess.userId],
    );
    return r.rows as ConnectionView[];
  });
  return Response.json({ connections });
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
  const driver = str(body["driver"]) as Driver;
  const host = str(body["host"]);
  const database = str(body["database"]);
  const username = str(body["username"]);
  const password = typeof body["password"] === "string" ? body["password"] : "";

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!DRIVERS.includes(driver)) {
    return Response.json({ error: `driver must be one of: ${DRIVERS.join(", ")}` }, { status: 400 });
  }
  if (!host) return Response.json({ error: "host is required" }, { status: 400 });

  const options = parseOptions(body["options"]);
  if (options === null) return Response.json({ error: "options must be a JSON object" }, { status: 400 });
  const thePort = port(body["port"], DEFAULT_PORT[driver]);

  const slug = slugify(name);
  const key = passKey(slug);

  // Seal the password first (when given); only record the connection once the vault write succeeds.
  // A passwordless DB (trust auth / local socket) is allowed — pass_key stays empty.
  if (password) {
    if (!(await vaultPut(req, key, password))) {
      return Response.json({ error: "could not store the password in the vault" }, { status: 502 });
    }
  }

  try {
    const connection = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `insert into plugin_db.connections
           (user_id, name, slug, driver, host, port, database, username, options, pass_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         returning ${CONNECTION_COLUMNS}`,
        [
          sess.userId,
          name,
          slug,
          driver,
          host,
          thePort,
          database,
          username,
          JSON.stringify(options),
          password ? key : "",
        ],
      );
      return r.rows[0] as ConnectionView;
    });
    return Response.json({ ok: true, connection });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_db_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "you already have a connection with that name" }, { status: 409 });
    }
    return Response.json({ error: "could not create connection" }, { status: 500 });
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
  const driver = str(body["driver"]) as Driver;
  const host = str(body["host"]);
  const database = str(body["database"]);
  const username = str(body["username"]);
  const password = typeof body["password"] === "string" ? body["password"] : "";

  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!DRIVERS.includes(driver)) {
    return Response.json({ error: `driver must be one of: ${DRIVERS.join(", ")}` }, { status: 400 });
  }
  if (!host) return Response.json({ error: "host is required" }, { status: 400 });

  const options = parseOptions(body["options"]);
  if (options === null) return Response.json({ error: "options must be a JSON object" }, { status: 400 });
  const thePort = port(body["port"], DEFAULT_PORT[driver]);

  // The slug / vault key are frozen at creation, so a rename never orphans the sealed password.
  const existing = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select pass_key, slug from plugin_db.connections where id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    return r.rows[0] as { pass_key: string; slug: string } | undefined;
  });
  if (!existing) return Response.json({ error: "no such connection" }, { status: 404 });

  // Re-seal only when a new password was entered; blank keeps the current sealed one.
  let passKeyToStore = existing.pass_key;
  if (password) {
    const key = existing.pass_key || passKey(existing.slug);
    if (!(await vaultPut(req, key, password))) {
      return Response.json({ error: "could not store the password in the vault" }, { status: 502 });
    }
    passKeyToStore = key;
  }

  const connection = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_db.connections
          set name=$3, driver=$4, host=$5, port=$6, database=$7, username=$8, options=$9::jsonb, pass_key=$10, updated_at=now()
        where id=$1 and user_id=$2 and status='active'
        returning ${CONNECTION_COLUMNS}`,
      [id, sess.userId, name, driver, host, thePort, database, username, JSON.stringify(options), passKeyToStore],
    );
    return r.rows[0] as ConnectionView;
  });
  return Response.json({ ok: true, connection });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const removed = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_db.connections set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status = 'active'
        returning pass_key`,
      [id, sess.userId],
    );
    return r.rows[0] as { pass_key: string } | undefined;
  });
  if (!removed) return Response.json({ error: "no such connection" }, { status: 404 });
  if (removed.pass_key) await vaultDelete(req, removed.pass_key);
  return Response.json({ ok: true });
}
