"use client";

import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/components/providers/auth-provider";

/**
 * Global header.
 *
 * Phase 1 surface is intentionally bare: brand on the left, auth
 * affordance on the right. The day-cost counter and the user menu
 * (`docs/014 §4.1`) are wired in follow-up issues.
 */
export function Header(): React.ReactElement {
  const { user, loading, configError, signOut } = useAuth();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="text-sm font-medium tracking-tight text-foreground"
        >
          Today
        </Link>
      </div>

      <div className="flex items-center gap-3 text-xs">
        {loading ? (
          <span className="text-muted-foreground">…</span>
        ) : configError ? (
          <span className="text-red-600">backend unavailable</span>
        ) : user ? (
          <>
            <Link
              href="/settings"
              className="text-muted-foreground hover:text-foreground"
            >
              Settings
            </Link>
            <span
              className="text-muted-foreground"
              data-testid="operator-email"
            >
              {user.email ?? user.id}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void signOut();
              }}
            >
              Sign out
            </Button>
          </>
        ) : (
          <Link
            href="/login"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Log in
          </Link>
        )}
      </div>
    </header>
  );
}
