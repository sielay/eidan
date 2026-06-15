// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

// Server-side login gate — the pattern potem uses. The session is the HttpOnly
// `eidan_refresh` cookie minted by /api/auth/verify; its presence means "has a
// session" (the route handlers + AuthProvider still validate it against the DB).
// No cookie → bounce to /login (pages) or 401 (api). The login page and the
// public /api/auth/* endpoints (config / magic-link / verify / refresh / logout)
// are the only unauthenticated surfaces. This runs on Vercel's edge — no DB here,
// just a cookie presence check, so a stale cookie still reaches the route which
// then does the real validation and clears it.
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // CORS preflight is unauthenticated by spec — let the route's OPTIONS answer.
  if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Always-public surfaces: the login page + the unauthenticated auth endpoints.
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  // PWA assets must be reachable without a session, or an offline / logged-out
  // browser can't install the app or render the offline fallback: the service
  // worker (/sw.js), the web manifest, the app icons, and the offline page.
  if (
    pathname === "/sw.js" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/offline" ||
    pathname.startsWith("/icons/")
  ) {
    return NextResponse.next();
  }

  // Bearer-authenticated API callers (the engine, scripts, other agents) carry the
  // HS256 access token in the Authorization header, not the first-party
  // `eidan_refresh` cookie. Let them reach the route, whose verifyBearer does the
  // real cryptographic validation. Without this the cookie presence-check below
  // 401s every header-only API request before the token can be validated. (Browser
  // calls send both cookie + header, so they pass either gate.)
  if (pathname.startsWith("/api/")) {
    const authz = request.headers.get("authorization");
    if (authz && authz.startsWith("Bearer ")) {
      return NextResponse.next();
    }
  }

  if (!request.cookies.has("eidan_refresh")) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals, static assets, and PWA files
  // (service worker, its build chunks, and the web manifest).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw.js|swe-worker-.*\\.js|workbox-.*\\.js|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
