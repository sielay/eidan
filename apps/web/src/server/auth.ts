// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-side bearer verification for the Next data routes. Same HS256 + shared secret the engine's
// @eidandev/auth resolver uses, so a token minted by either side verifies on both. Returns the
// session (userId + iat for session-scoped windows) or null.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface Session {
  userId: string;
  email: string;
  iat: number;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
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
