// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { CloudOff, RefreshCw, Wifi } from "lucide-react";

/**
 * The body of the offline fallback page (src/app/offline/page.tsx).
 *
 * Watches `online`/`offline` events: while offline it explains the situation
 * calmly; once the connection returns it offers a one-tap reload back into the
 * live app. The cached app shell remains usable around this — the chat and live
 * dashboards are the parts that need the network.
 */
export function OfflineNotice(): React.ReactElement {
  const [online, setOnline] = React.useState(true);

  React.useEffect(() => {
    const sync = (): void => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const reload = React.useCallback(() => {
    window.location.assign("/");
  }, []);

  return (
    <div style={{ maxWidth: 420, textAlign: "center" }}>
      <div
        aria-hidden
        style={{
          width: 64,
          height: 64,
          margin: "0 auto var(--s5, 20px)",
          display: "grid",
          placeItems: "center",
          borderRadius: "var(--r-full, 999px)",
          background: online ? "var(--good-tint, #ECF4ED)" : "var(--surface-2, #F4F4F2)",
          color: online ? "var(--good, #4E9A51)" : "var(--muted, #6B6B73)",
        }}
      >
        {online ? (
          <Wifi style={{ width: 28, height: 28 }} />
        ) : (
          <CloudOff style={{ width: 28, height: 28 }} />
        )}
      </div>

      <h1
        style={{
          fontSize: "var(--fs-24, 1.5rem)",
          fontWeight: 600,
          margin: "0 0 var(--s3, 12px)",
        }}
      >
        {online ? "You're back online" : "You're offline"}
      </h1>

      <p
        style={{
          color: "var(--muted, #6B6B73)",
          lineHeight: "var(--lh, 1.5)",
          margin: "0 0 var(--s6, 24px)",
        }}
      >
        {online
          ? "Your connection is back. Reload to continue where you left off."
          : "eidan needs a connection for chat and live data. The app shell is cached, so it'll spring back the moment you're reconnected."}
      </p>

      <button
        type="button"
        onClick={reload}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--s2, 8px)",
          padding: "var(--s3, 12px) var(--s5, 20px)",
          borderRadius: "var(--r-md, 12px)",
          background: "var(--accent, #4F46E5)",
          color: "var(--accent-contrast, #fff)",
          fontWeight: 500,
          fontSize: "var(--fs-15, 0.9375rem)",
          border: "none",
          cursor: "pointer",
        }}
      >
        <RefreshCw style={{ width: 16, height: 16 }} aria-hidden />
        {online ? "Reload" : "Try again"}
      </button>
    </div>
  );
}
