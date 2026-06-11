// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { getBackendBase } from "@/lib/auth";

/**
 * Shape returned by the backend's `/api/auth/config` endpoint
 * (`docs/011 §3.4`). Native auth — no Supabase fields. The
 * operator's pinned email is intentionally NOT here: this endpoint
 * is public + unauthenticated, and the verify endpoint re-checks
 * `EIDAN_AUTH_ALLOWED_EMAIL` server-side on every magic-link
 * submission, so the UI doesn't need it. Browser form autofill
 * remembers the email after first login.
 */
export interface AuthConfig {
  provider: string;
  providers: string[];
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
