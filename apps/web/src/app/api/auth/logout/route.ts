// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/auth/logout — revoke the refresh session and clear the cookie.
import type { NextRequest } from "next/server";

import { query } from "@/server/db";
import { sha256hex, readCookie, clearRefreshCookie } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const cookie = readCookie(req, "eidan_refresh");
  if (cookie) {
    await query("update eidan.auth_sessions set revoked_at=now() where refresh_token_hash=$1 and revoked_at is null", [sha256hex(cookie)]);
  }
  const headers = new Headers();
  headers.append("set-cookie", clearRefreshCookie(req));
  return Response.json({ ok: true }, { headers });
}
