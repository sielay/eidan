"use client";

import Link from "next/link";

import { useAuth } from "@/components/providers/auth-provider";
import { buttonVariants } from "@/components/ui/button";

/**
 * Today / conversation-list landing.
 *
 * Per `docs/014 §3` the host renders `/c` as the post-login default;
 * for Phase 3 this is a placeholder that simply prompts the operator
 * to sign in when no user is present and surfaces an empty state
 * otherwise. The real conversation list ships in a follow-up issue.
 */
export default function HomePage(): React.ReactElement {
  const { user, loading } = useAuth();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Today</h1>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : user ? (
        <p className="text-sm text-muted-foreground">
          No conversations yet. The conversation list and the “new
          conversation” affordance land in a follow-up issue.
        </p>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-md border border-border bg-muted/30 p-6">
          <p className="text-sm text-muted-foreground">
            You are not signed in.
          </p>
          <Link
            href="/login"
            className={buttonVariants({ variant: "default", size: "default" })}
          >
            Log in
          </Link>
        </div>
      )}
    </div>
  );
}
