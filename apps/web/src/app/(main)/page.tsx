// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";

import { useAuth } from "@/components/providers/auth-provider";

/**
 * Chat landing (`docs/014 §3`). Post-login default surface; the
 * conversation list + "new conversation" affordance land in a follow-up
 * issue. Styled to the design system (UI_DESIGN_BRIEF) — a calm empty
 * state, not a placeholder dump.
 */
export default function HomePage(): React.ReactElement {
  const { user, loading } = useAuth();

  return (
    <div className="content">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Chat</h1>
          <div className="screen-sub">Your conversations with eidan</div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <p className="screen-sub">Loading…</p>
        ) : user ? (
          <div className="empty">
            <div className="empty__title">A calm, capable assistant</div>
            <div className="empty__body">
              Start a conversation — eidan remembers what matters and can act
              on your behalf. The conversation list lands in a follow-up issue.
            </div>
          </div>
        ) : (
          <div className="empty">
            <div className="empty__title">You are not signed in</div>
            <div className="empty__body">Sign in to start chatting with eidan.</div>
            <Link href="/login" className="btn btn--primary">
              Log in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
