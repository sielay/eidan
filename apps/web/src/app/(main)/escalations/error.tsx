// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

/**
 * Route-level error boundary for the escalations inbox. A render-time throw here
 * previously took down the whole client app (blank screen on Vercel); this catches
 * it, surfaces the actual message (so it's diagnosable), and offers a retry instead.
 */
export default function EscalationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Escalations</h1>
      <p className="text-sm text-muted-foreground">Something went wrong rendering the inbox.</p>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 font-mono text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        {error.message}
        {error.digest ? `\n\n(digest: ${error.digest})` : ""}
      </pre>
      <button
        type="button"
        onClick={reset}
        className="self-start rounded-md border border-border bg-background px-3 py-1 text-sm hover:bg-muted"
      >
        Try again
      </button>
    </div>
  );
}
