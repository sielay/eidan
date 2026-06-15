// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";

import { OfflineNotice } from "@/components/pwa/OfflineNotice";

// The service worker serves this precached document as the fallback for any
// navigation that fails while offline (see src/app/sw.ts `fallbacks`). It must
// be fully static and self-contained — no data fetching, no auth — so it always
// renders from cache. The interactive "retry" affordance lives in the client
// component so this page itself stays a server component.
export const metadata: Metadata = {
  title: "Offline — eidan",
  robots: { index: false },
};

export const dynamic = "force-static";

export default function OfflinePage(): React.ReactElement {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "var(--s6, 24px)",
        background: "var(--bg, #FBFBFA)",
        color: "var(--text, #1D1D23)",
      }}
    >
      <OfflineNotice />
    </main>
  );
}
