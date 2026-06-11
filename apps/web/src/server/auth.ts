// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-side bearer verification for the Next data routes. Same HS256 + shared secret the engine's
// @eidandev/auth resolver uses, so a token minted by either side verifies on both. Returns the
// session (userId + iat for session-scoped windows) or null.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export interface Session {
  userId: string;
  email: string;
  iat: number;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function authSecret(): string {
  const s = process.env.EIDAN_AUTH_JWT_SECRET ?? process.env.EIDAN_AUTH_MASTER_KEY;
  if (!s) throw new Error("EIDAN_AUTH_JWT_SECRET (or EIDAN_AUTH_MASTER_KEY) is required for auth");
  return s;
}

// Mint an access JWT the engine's @eidandev/auth resolver verifies (same HS256 secret).
export function signAccessToken(userId: string, email: string, ttlSec = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: userId, email, typ: "access", iat: now, exp: now + ttlSec })).toString("base64url");
  const sig = createHmac("sha256", authSecret()).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
export const randomToken = (): string => randomBytes(32).toString("base64url");
export const randomCode = (): string => String(randomInt(100000, 1000000)); // 6 digits, CSPRNG

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

// Same-origin first-party cookie (the Next app is the front door). Secure on https; relaxed on
// http://localhost for dev. SameSite=Lax survives top-level navigation (the magic-link click).
export function refreshCookie(req: Request, value: string, maxAgeSec: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `eidan_refresh=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure}`;
}
export function clearRefreshCookie(req: Request): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `eidan_refresh=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export function verifyBearer(req: Request): Session | null {
  const auth = req.headers.get("authorization");
  const token = auth && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const secret = process.env.EIDAN_AUTH_JWT_SECRET ?? process.env.EIDAN_AUTH_MASTER_KEY;
  if (!token || !secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  if (!h || !p || !sig) return null;

  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const actual = b64urlToBuf(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let claims: { sub?: unknown; email?: unknown; exp?: unknown; iat?: unknown };
  try {
    claims = JSON.parse(b64urlToBuf(p).toString("utf8")) as typeof claims;
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
  if (typeof claims.sub !== "string" || claims.sub === "") return null;

  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    iat: typeof claims.iat === "number" ? claims.iat : 0,
  };
}
