// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/auth/verify {token|code} — consume a magic link, find/create the human user, open a
// refresh session, and return an access JWT + set the refresh cookie.
import type { NextRequest } from "next/server";

import { query } from "@/server/db";
import { sha256hex, randomToken, signAccessToken, refreshCookie } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFRESH_DAYS = 30;

export async function POST(req: NextRequest): Promise<Response> {
  let token: string | undefined;
  let code: string | undefined;
  try {
    const b = (await req.json()) as { token?: unknown; code?: unknown };
    token = typeof b.token === "string" ? b.token : undefined;
    code = typeof b.code === "string" ? b.code : undefined;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  let rec: { id: string; email: string } | undefined;
  if (token) {
    const r = await query(
      "select id, email from eidan.auth_magic_links where token_hash=$1 and consumed_at is null and expires_at > now() order by created_at desc limit 1",
      [sha256hex(token)],
    );
    rec = r.rows[0] as typeof rec;
  } else if (code) {
    const r = await query(
      "select id, email from eidan.auth_magic_links where code=$1 and consumed_at is null and expires_at > now() order by created_at desc limit 1",
      [code],
    );
    rec = r.rows[0] as typeof rec;
  }
  if (!rec) return new Response("invalid or expired", { status: 401 });

  const allowed = process.env.EIDAN_AUTH_ALLOWED_EMAIL?.toLowerCase();
  if (allowed && rec.email.toLowerCase() !== allowed) return new Response("not allowed", { status: 403 });

  // Consume the link (single-use).
  await query("update eidan.auth_magic_links set consumed_at=now() where id=$1", [rec.id]);

  // Find or create the human user for this email.
  let user = (
    await query("select id, email from eidan.users where lower(email)=lower($1) and kind='human' limit 1", [rec.email])
  ).rows[0] as { id: string; email: string } | undefined;
  if (!user) {
    user = (
      await query("insert into eidan.users (id, email, kind) values (gen_random_uuid(), $1, 'human') returning id, email", [rec.email])
    ).rows[0] as { id: string; email: string };
  }

  // Open a refresh session (opaque token, stored hashed).
  const refresh = randomToken();
  const sessExp = new Date(Date.now() + REFRESH_DAYS * 24 * 3600 * 1000).toISOString();
  await query(
    "insert into eidan.auth_sessions (id, user_id, refresh_token_hash, expires_at, user_agent) values (gen_random_uuid(), $1, $2, $3, $4)",
    [user.id, sha256hex(refresh), sessExp, (req.headers.get("user-agent") ?? "").slice(0, 400)],
  );

  const headers = new Headers();
  headers.append("set-cookie", refreshCookie(req, refresh, REFRESH_DAYS * 24 * 3600));
  return Response.json(
    { access_token: signAccessToken(user.id, user.email), user: { id: user.id, email: user.email } },
    { headers },
  );
}
