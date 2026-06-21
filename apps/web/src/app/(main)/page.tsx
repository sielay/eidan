// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { ConversationList } from "@/components/conversation/ConversationList";

/**
 * Chat landing (`docs/014 §3`). Post-login default surface: the live
 * conversation list (real `GET /api/conversations`) with the "new
 * conversation" affordance. The list component owns its own loading,
 * empty, and error states.
 */
export default function HomePage(): React.ReactElement {
  return (
    <div className="content">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Chat</h1>
          <div className="screen-sub">Your conversations with eidan</div>
        </div>
      </div>
      <React.Suspense
        fallback={
          <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
            Loading…
          </p>
        }
      >
        <ConversationList />
      </React.Suspense>
    </div>
  );
}
