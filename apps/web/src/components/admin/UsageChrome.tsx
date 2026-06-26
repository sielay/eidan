// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

const USAGE_TABS = ["overview", "models", "providers", "nodes", "calls"] as const;

export function UsageChrome({
  activeTab,
  children,
}: {
  activeTab: (typeof USAGE_TABS)[number];
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mx-auto max-w-6xl flex flex-col gap-4 px-6 py-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Usage & Costs</h1>
      </header>

      <nav className="flex items-center gap-1.5 text-xs" role="tablist">
        {USAGE_TABS.map((tab) => (
          <Link
            key={tab}
            href={`/admin/usage/${tab}`}
            role="tab"
            aria-selected={activeTab === tab}
            className={cn(
              "rounded-md border px-2 py-1 capitalize",
              activeTab === tab
                ? "border-foreground/30 bg-muted text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            {tab}
          </Link>
        ))}
      </nav>

      <div>{children}</div>
    </div>
  );
}
