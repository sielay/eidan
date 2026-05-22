"use client";

import { getBackendBase } from "@/lib/auth";

/**
 * Shape returned by the backend's `/api/auth/config` endpoint
 * (`docs/011 §3.4`). Native auth — no Supabase fields. The
 * `allowed_email` hint lets the UI pre-fill the login form; the
 * verify endpoint always re-checks against
 * `EIDAN_AUTH_ALLOWED_EMAIL` so this is purely UX.
 */
export interface AuthConfig {
  provider: string;
  providers: string[];
  allowed_email: string | null;
  tos_url: string | null;
  privacy_url: string | null;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const base = getBackendBase();
  const res = await fetch(`${base}/api/auth/config`, {
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`/api/auth/config returned ${res.status}`);
  }
  return (await res.json()) as AuthConfig;
}
