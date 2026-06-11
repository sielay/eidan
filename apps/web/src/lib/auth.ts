// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

/**
 * Native auth client — talks to the backend's /api/auth/* surface
 * (`docs/011 §11–§15`). No Supabase JS dependency.
 *
 * Strategy:
 *   - Access JWT is held in module-level memory only. Never touches
 *     localStorage (XSS-resistant; the access token is short-lived
 *     anyway and a refresh round-trip on page load is cheap).
 *   - Refresh token lives in an httpOnly cookie scoped to
 *     /api/auth/refresh, set by the backend on /api/auth/verify.
 *     Browser sends it automatically; JS never sees it.
 *   - On boot the AuthProvider calls `refreshAccessToken()`; if the
 *     refresh cookie is valid, that primes the in-memory access
 *     token and the user is "logged in". If not, the UI shows the
 *     login form.
 *   - Token expiry is checked before every authenticated fetch; if
 *     <60s remain, refresh first.
 */

// The Next app is the same-origin front door: the browser ALWAYS calls its own
// origin — /api/auth/* is handled locally and chat is proxied to the engine
// server-side (EIDAN_ENGINE_URL). Hardcoded "" on purpose so NO env (project,
// committed .env, or a team-shared var) can send the browser cross-origin to the
// engine, which would fail-closed with 401. Do not reintroduce a NEXT_PUBLIC read.
const BACKEND_BASE = "";

interface AccessTokenSlot {
  token: string;
  /** Unix epoch seconds. */
  expiresAt: number;
  email: string;
  userId: string;
}

let _accessToken: AccessTokenSlot | null = null;
const _listeners = new Set<(slot: AccessTokenSlot | null) => void>();

function _broadcast(): void {
  for (const listener of _listeners) {
    listener(_accessToken);
  }
}

/**
 * Subscribe to access-token changes. Returns an unsubscribe fn.
 *
 * Used by the AuthProvider to keep its React state in sync with
 * the module-level token slot — any sign-in / refresh / logout
 * fires the listener with the new state.
 */
export function onAuthStateChange(
  listener: (slot: AccessTokenSlot | null) => void,
): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

export function currentAccessToken(): AccessTokenSlot | null {
  return _accessToken;
}

function _storeAccessToken(slot: AccessTokenSlot): void {
  _accessToken = slot;
  _broadcast();
}

function _clearAccessToken(): void {
  _accessToken = null;
  _broadcast();
}

/**
 * Decode a JWT body without verifying the signature. Used purely
 * to extract `exp` + `email` + `sub` so the in-memory slot knows
 * when to pre-emptively refresh. The backend always re-verifies on
 * the next request — this side has no security role.
 */
function _decodeJwtBody(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid JWT shape");
  }
  // base64url → base64
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  return JSON.parse(atob(padded));
}

function _absorbAccessTokenResponse(body: {
  access_token: string;
  user?: { id: string; email: string };
}): AccessTokenSlot {
  const claims = _decodeJwtBody(body.access_token);
  const slot: AccessTokenSlot = {
    token: body.access_token,
    expiresAt: typeof claims.exp === "number" ? claims.exp : 0,
    email:
      body.user?.email ??
      (typeof claims.email === "string" ? claims.email : ""),
    userId:
      body.user?.id ?? (typeof claims.sub === "string" ? claims.sub : ""),
  };
  _storeAccessToken(slot);
  return slot;
}

function _backendUrl(path: string): string {
  if (path.startsWith("http")) return path;
  const normalised = path.startsWith("/") ? path : `/${path}`;
  return `${BACKEND_BASE}${normalised}`;
}

/* -----------------------------------------------------------------
 *  Public flow: magic link request / verify / refresh / logout
 * ---------------------------------------------------------------*/

export async function requestMagicLink(email: string): Promise<{
  status: string;
  magic_link?: string;
  code?: string;
}> {
  const res = await fetch(_backendUrl("/api/auth/magic-link"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw new Error(`magic-link request failed (${res.status})`);
  }
  return res.json();
}

export async function verifyMagicLink(
  args: { token?: string; code?: string },
): Promise<AccessTokenSlot> {
  const res = await fetch(_backendUrl("/api/auth/verify"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`verify failed (${res.status}): ${detail}`);
  }
  return _absorbAccessTokenResponse(await res.json());
}

/**
 * Try to mint a fresh access token off the refresh cookie. Resolves
 * to the new slot on success, null when the cookie is missing or
 * expired (logged-out state). Never throws — the caller can treat
 * `null` as "not authenticated".
 */
export async function refreshAccessToken(): Promise<AccessTokenSlot | null> {
  try {
    const res = await fetch(_backendUrl("/api/auth/refresh"), {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      _clearAccessToken();
      return null;
    }
    return _absorbAccessTokenResponse(await res.json());
  } catch {
    _clearAccessToken();
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch(_backendUrl("/api/auth/logout"), {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // Network blip during logout is non-fatal — the access token is
    // dropped client-side either way.
  }
  _clearAccessToken();
}

/* -----------------------------------------------------------------
 *  Authenticated fetch — used by every API client in the app
 * ---------------------------------------------------------------*/

export type AuthFetchInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

/**
 * Fetch wrapper that attaches the access token and auto-refreshes
 * when the token is missing or within 60 seconds of expiry. The
 * caller passes only the path (`/api/...`) — the backend base URL
 * is added here.
 *
 * One subtle behaviour worth keeping in mind: if the access token
 * has somehow gone stale on the server (refresh missed, key
 * rotated, etc.) the request comes back 401. The caller can retry
 * after calling `refreshAccessToken()` — this wrapper doesn't loop
 * to avoid hiding sign-out bugs.
 */
export async function authFetch(
  path: string,
  init: AuthFetchInit = {},
): Promise<Response> {
  // Pre-emptive refresh: if within a minute of expiry (or already
  // expired), grab a new token first so the API call doesn't 401.
  const slot = _accessToken;
  const now = Math.floor(Date.now() / 1000);
  if (slot === null || slot.expiresAt - now < 60) {
    await refreshAccessToken();
  }

  const url = _backendUrl(path);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers ?? {}),
  };
  const active = _accessToken;
  if (active !== null) {
    headers["Authorization"] = `Bearer ${active.token}`;
  }
  return fetch(url, { ...init, headers, credentials: "include" });
}

export function getBackendBase(): string {
  return BACKEND_BASE;
}
