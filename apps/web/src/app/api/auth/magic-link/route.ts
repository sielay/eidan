// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/auth/magic-link {email} — issue a one-time sign-in link + 6-digit code (eidan.auth_magic_links).
// Always returns the same success shape so it never leaks which emails are allowed. Emails the link
// when SMTP is configured; otherwise echoes it (dev — no mailer needed).
import type { NextRequest } from "next/server";

import { query } from "@/server/db";
import { sha256hex, randomToken, randomCode } from "@/server/auth";
import { sendMagicLink } from "@/server/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  let email = "";
  try {
    const b = (await req.json()) as { email?: unknown };
    email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  } catch {
    /* fall through to the generic success */
  }
  if (!email || !email.includes("@")) return Response.json({ status: "sent" });

  const allowed = process.env.EIDAN_AUTH_ALLOWED_EMAIL?.toLowerCase();
  if (allowed && email !== allowed) return Response.json({ status: "sent" });
  const isAdmin = Boolean(allowed) && email === allowed;

  const token = randomToken();
  const code = randomCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await query(
    "insert into eidan.auth_magic_links (id, email, token_hash, code, expires_at) values (gen_random_uuid(), $1, $2, $3, $4)",
    [email, sha256hex(token), code, expiresAt],
  );

  const origin = process.env.EIDAN_PUBLIC_ORIGIN ?? new URL(req.url).origin;
  const link = `${origin}/login?token=${token}`;
  const { sent, error } = await sendMagicLink(email, link, code);
  if (sent) return Response.json({ status: "sent" });

  // Not emailed (SMTP unconfigured, or the send failed). Echo the link/code so login still works — but
  // ONLY for the configured admin, or in dev when no SMTP is set at all. Never leak to arbitrary
  // requesters in prod: fall back to the same generic success the allow-list path returns.
  const smtpConfigured = Boolean(process.env.EIDAN_SMTP_HOST);
  if (isAdmin || !smtpConfigured) {
    console.warn(`[magic-link] not emailed (${error ?? "smtp not configured"}) — echoing link for ${email}`);
    return Response.json({ status: "sent", magic_link: link, code });
  }
  console.error(`[magic-link] send failed for ${email}, not echoed: ${error}`);
  return Response.json({ status: "sent" });
}
