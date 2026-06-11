// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/auth/refresh — mint a fresh access JWT off the refresh cookie (a valid, non-revoked,
// unexpired eidan.auth_sessions row). 401 when there's no live session (logged-out state).
import type { NextRequest } from "next/server";

import { query } from "@/server/db";
import { sha256hex, signAccessToken, readCookie } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const cookie = readCookie(req, "eidan_refresh");
  if (!cookie) return new Response("no session", { status: 401 });

  const r = await query(
    `select s.id, s.user_id, u.email
       from eidan.auth_sessions s join eidan.users u on u.id = s.user_id
      where s.refresh_token_hash = $1 and s.revoked_at is null and s.expires_at > now() limit 1`,
    [sha256hex(cookie)],
  );
  const sess = r.rows[0] as { id: string; user_id: string; email: string } | undefined;
  if (!sess) return new Response("no session", { status: 401 });

  await query("update eidan.auth_sessions set last_used_at=now() where id=$1", [sess.id]);
  return Response.json({ access_token: signAccessToken(sess.user_id, sess.email), user: { id: sess.user_id, email: sess.email } });
}
