// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/imap/accounts — the Mail-accounts admin data route (Next-reads-Postgres, the Surface-B
// pattern). Manages the operator's named mail accounts in plugin_imap.accounts and seals each
// account's IMAP/SMTP password into the vault via the engine's secrets-api (the LLM-free write
// path). The non-secret connection fields (hosts, ports, usernames, From) are stored in the
// registry; passwords are never read back or returned. Owner-scoped; shipped in the bundle's
// frontend package, mounted under apps/web at deploy.
//   GET                                → { accounts: [{ id, name, slug, imap_host, ... (no passwords) }] }
//   POST   { name, imap_*, smtp_*, imap_password, smtp_password } → seal passwords + insert row
//   PUT  ?id=<id> { name, imap_*, smtp_*, imap_password?, smtp_password? } → update connection fields;
//                                        re-seal a password only when a new one is supplied (blank
//                                        keeps the current sealed secret); slug/vault keys stay stable.
//   DELETE ?id=<id>                    → archive the row + remove its vault secrets
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Non-secret view of an account — what the UI lists. Passwords (and their vault keys) are omitted.
interface AccountView {
  id: string;
  name: string;
  slug: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_from: string;
}

const ACCOUNT_COLUMNS =
  "id, name, slug, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, smtp_from";

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "account";
}

function imapPassKey(slug: string): string {
  return `EIDAN_IMAP_PASS_${slug}`;
}

function smtpPassKey(slug: string): string {
  return `EIDAN_SMTP_PASS_${slug}`;
}

// A port that defaults when missing/invalid, and stays within range.
function port(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
  const accounts = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select ${ACCOUNT_COLUMNS}
         from plugin_imap.accounts
        where user_id = $1 and status = 'active'
        order by created_at`,
      [sess.userId],
    );
    return r.rows as AccountView[];
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

  const name = str(body["name"]);
  const imapHost = str(body["imap_host"]);
  const imapUser = str(body["imap_user"]);
  const imapPassword = typeof body["imap_password"] === "string" ? body["imap_password"] : "";
  const smtpHost = str(body["smtp_host"]);
  const smtpUser = str(body["smtp_user"]) || imapUser;
  const smtpPassword = typeof body["smtp_password"] === "string" ? body["smtp_password"] : "";
  const smtpFrom = str(body["smtp_from"]);
  const imapPort = port(body["imap_port"], 993);
  const smtpPort = port(body["smtp_port"], 587);

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!imapHost) return Response.json({ error: "imap_host is required" }, { status: 400 });
  if (!imapUser) return Response.json({ error: "imap_user is required" }, { status: 400 });
  if (!imapPassword) return Response.json({ error: "imap_password is required" }, { status: 400 });
  // SMTP is optional (read-only accounts are valid); but if a host is given, require a password.
  if (smtpHost && !smtpPassword) {
    return Response.json({ error: "smtp_password is required when an SMTP host is set" }, { status: 400 });
  }

  const slug = slugify(name);
  const imapKey = imapPassKey(slug);
  const smtpKey = smtpPassKey(slug);

  // Seal the password(s) first; only record the account once the vault write(s) succeed.
  if (!(await vaultPut(req, imapKey, imapPassword))) {
    return Response.json({ error: "could not store the IMAP password in the vault" }, { status: 502 });
  }
  if (smtpHost && smtpPassword) {
    if (!(await vaultPut(req, smtpKey, smtpPassword))) {
      return Response.json({ error: "could not store the SMTP password in the vault" }, { status: 502 });
    }
  }

  try {
    const account = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `insert into plugin_imap.accounts
           (user_id, name, slug, imap_host, imap_port, imap_user, imap_pass_key,
            smtp_host, smtp_port, smtp_user, smtp_pass_key, smtp_from)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning ${ACCOUNT_COLUMNS}`,
        [
          sess.userId,
          name,
          slug,
          imapHost,
          imapPort,
          imapUser,
          imapKey,
          smtpHost,
          smtpPort,
          smtpHost ? smtpUser : "",
          smtpHost ? smtpKey : "",
          smtpFrom,
        ],
      );
      return r.rows[0] as AccountView;
    });
    return Response.json({ ok: true, account });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_imap_user_slug|duplicate key/i.test(msg)) {
      return Response.json({ error: "you already have a mail account with that name" }, { status: 409 });
    }
    return Response.json({ error: "could not create mail account" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Load the existing row. We keep its slug + vault keys STABLE across an edit: passwords are sealed
  // under keys derived from the original slug, so a rename must not re-key them or the sealed secrets
  // would orphan. Passwords aren't returned to the browser, so a blank password field means "keep the
  // current sealed secret" — only re-seal when the operator types a new one.
  const existing = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select slug, imap_pass_key, smtp_pass_key
         from plugin_imap.accounts
        where id = $1 and user_id = $2 and status = 'active'`,
      [id, sess.userId],
    );
    return r.rows[0] as { slug: string; imap_pass_key: string; smtp_pass_key: string } | undefined;
  });
  if (!existing) return Response.json({ error: "no such account" }, { status: 404 });

  const name = str(body["name"]);
  const imapHost = str(body["imap_host"]);
  const imapUser = str(body["imap_user"]);
  const imapPassword = typeof body["imap_password"] === "string" ? body["imap_password"] : "";
  const smtpHost = str(body["smtp_host"]);
  const smtpUser = str(body["smtp_user"]) || imapUser;
  const smtpPassword = typeof body["smtp_password"] === "string" ? body["smtp_password"] : "";
  const smtpFrom = str(body["smtp_from"]);
  const imapPort = port(body["imap_port"], 993);
  const smtpPort = port(body["smtp_port"], 587);

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!imapHost) return Response.json({ error: "imap_host is required" }, { status: 400 });
  if (!imapUser) return Response.json({ error: "imap_user is required" }, { status: 400 });

  // Reuse the existing vault keys (or mint one from the original slug if a prior save left it empty).
  const imapKey = existing.imap_pass_key || imapPassKey(existing.slug);
  const smtpKey = existing.smtp_pass_key || smtpPassKey(existing.slug);

  // IMAP: re-seal only if a new password was given; otherwise the existing sealed secret must exist.
  if (imapPassword) {
    if (!(await vaultPut(req, imapKey, imapPassword))) {
      return Response.json({ error: "could not store the IMAP password in the vault" }, { status: 502 });
    }
  } else if (!existing.imap_pass_key) {
    return Response.json({ error: "imap_password is required" }, { status: 400 });
  }

  // SMTP is optional. If a host is set we need a sealed password (new, or a pre-existing one).
  if (smtpHost) {
    if (smtpPassword) {
      if (!(await vaultPut(req, smtpKey, smtpPassword))) {
        return Response.json({ error: "could not store the SMTP password in the vault" }, { status: 502 });
      }
    } else if (!existing.smtp_pass_key) {
      return Response.json({ error: "smtp_password is required when an SMTP host is set" }, { status: 400 });
    }
  }

  const account = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_imap.accounts set
         name = $1, imap_host = $2, imap_port = $3, imap_user = $4, imap_pass_key = $5,
         smtp_host = $6, smtp_port = $7, smtp_user = $8, smtp_pass_key = $9, smtp_from = $10,
         updated_at = now()
        where id = $11 and user_id = $12 and status = 'active'
       returning ${ACCOUNT_COLUMNS}`,
      [
        name,
        imapHost,
        imapPort,
        imapUser,
        imapKey,
        smtpHost,
        smtpPort,
        smtpHost ? smtpUser : "",
        smtpHost ? smtpKey : "",
        smtpHost ? smtpFrom : "",
        id,
        sess.userId,
      ],
    );
    return r.rows[0] as AccountView | undefined;
  });
  if (!account) return Response.json({ error: "no such account" }, { status: 404 });

  // SMTP was cleared on this edit — drop the now-orphaned sealed secret (best-effort).
  if (!smtpHost && existing.smtp_pass_key) await vaultDelete(req, existing.smtp_pass_key);

  return Response.json({ ok: true, account });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const removed = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `update plugin_imap.accounts set status = 'archived', updated_at = now()
        where id = $1 and user_id = $2 and status = 'active'
        returning imap_pass_key, smtp_pass_key`,
      [id, sess.userId],
    );
    return r.rows[0] as { imap_pass_key: string; smtp_pass_key: string } | undefined;
  });
  if (!removed) return Response.json({ error: "no such account" }, { status: 404 });
  if (removed.imap_pass_key) await vaultDelete(req, removed.imap_pass_key);
  if (removed.smtp_pass_key) await vaultDelete(req, removed.smtp_pass_key);
  return Response.json({ ok: true });
}
