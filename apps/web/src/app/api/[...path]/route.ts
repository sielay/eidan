// SPDX-License-Identifier: AGPL-3.0-or-later
// Front-door proxy: the browser talks only to the Next app (same-origin), and this catch-all
// forwards everything not served by a more specific route (auth, chat turn SSE, conversations) to
// the matbot engine. Same-origin means the auth refresh cookie is first-party — no fragile
// cross-site SameSite=None;Secure dance — so sessions survive the post-login reload.
//
// Specific data routes (e.g. /api/cost/summary, /api/knowledge) take precedence over this catch-all
// and read Postgres directly (the dashboards-from-Next-Postgres half of the architecture).
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENGINE = process.env.EIDAN_ENGINE_URL ?? "http://localhost:8090";

// Relay engine cookies as first-party over http://localhost: drop Secure + relax SameSite so the
// browser actually stores/sends them on the same-origin Next app.
function rewriteSetCookie(value: string): string {
  return value
    .replace(/;\s*SameSite=None/gi, "; SameSite=Lax")
    .replace(/;\s*Secure/gi, "");
}

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const url = `${ENGINE}/api/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

  const headers = new Headers();
  for (const h of ["authorization", "content-type", "accept", "cookie"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  const upstream = await fetch(url, init);

  const resHeaders = new Headers();
  // Forward Location/WWW-Authenticate/Retry-After so redirects (3xx) and auth challenges from the
  // engine survive the proxy — copying only content-type/cache-control would strip them.
  for (const h of ["content-type", "cache-control", "location", "www-authenticate", "retry-after"]) {
    const v = upstream.headers.get(h);
    if (v) resHeaders.set(h, v);
  }
  // Stream-friendly for SSE (the chat turn).
  if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    resHeaders.set("cache-control", "no-cache, no-transform");
    resHeaders.set("x-accel-buffering", "no");
  }
  for (const c of upstream.headers.getSetCookie?.() ?? []) {
    resHeaders.append("set-cookie", rewriteSetCookie(c));
  }

  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };
async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
