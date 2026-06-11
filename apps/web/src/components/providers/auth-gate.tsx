// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/providers/auth-provider";

/**
 * App-wide auth gate. Wraps the entire `(main)` tree so every screen — not just
 * chat — requires an authenticated session: while the boot refresh is in flight
 * we show a calm spinner, and an unauthenticated visitor is redirected to the
 * login screen rather than seeing empty/stub chrome.
 */
export function AuthGate({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { user, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="onb-page" aria-busy="true" aria-live="polite">
        <span className="login-spin login-spin--lg" aria-hidden />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  return <>{children}</>;
}
