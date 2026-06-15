// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

// Registers the Serwist-built service worker (public/sw.js) on the client after
// load. Renders nothing. In dev the SW is not emitted (next.config disables it),
// so registration is skipped; we also proactively unregister any stale worker so
// a previously-installed prod SW never shadows local development.
export function ServiceWorkerRegistrar(): null {
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => void r.unregister()))
        .catch(() => {
          /* best-effort */
        });
      return;
    }

    const register = (): void => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* registration failures must never break the app */
      });
    };

    // Defer until the page has settled so the SW install never competes with
    // first paint / hydration.
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
