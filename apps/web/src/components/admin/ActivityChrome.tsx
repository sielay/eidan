// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";

import { useAuth } from "@/components/providers/auth-provider";
import * as React from "react";

import { listAdminNodes, listAdminTriggers } from "@/lib/api/admin";
import { listConversations } from "@/lib/api/conversations";
import { cn } from "@/lib/utils";

/**
 * Tab + counter chrome around the three /admin/activity panes.
 *
 * Owns the live polling that drives the banner counts ("X nodes
 * online · Y conversations · Z triggers") so the numbers stay
 * accurate regardless of which tab is in front — a pattern lifted
 * from sibling job-dashboard surfaces where per-pane polling
 * leaves stale counts behind when the user clicks a sibling tab.
 *
 * 15 s cadence: matches the 30 s heartbeat in `docs/024 §3` (two
 * polls per beat is enough to render the freshness dot reliably)
 * while staying cheap on a deployment with a hand-counted plugin
 * count.
 */
export function ActivityChrome({
  activeTab,
  children,
}: {
  activeTab: "conversations" | "nodes" | "triggers";
  children: React.ReactNode;
}): React.ReactElement {
  const { user } = useAuth();
  const [nodesOnline, setNodesOnline] = React.useState<number | null>(null);
  const [nodesTotal, setNodesTotal] = React.useState<number | null>(null);
  const [conversationsCount, setConversationsCount] = React.useState<number | null>(
    null,
  );
  const [triggersCount, setTriggersCount] = React.useState<number | null>(null);
  const [dlqCount, setDlqCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;

    function load(): void {
      void listAdminNodes()
        .then((rows) => {
          if (cancelled) return;
          // Per `docs/024 §1.2` — 30 s heartbeat, so >90 s = three
          // missed beats = treat as offline regardless of the
          // stored row status.
          setNodesOnline(rows.filter((n) => n.seconds_since <= 90).length);
          setNodesTotal(rows.length);
        })
        .catch(() => {});
      void listConversations()
        .then((rows) => {
          if (cancelled) return;
          setConversationsCount(rows.length);
        })
        .catch(() => {});
      void listAdminTriggers()
        .then((body) => {
          if (cancelled) return;
          setTriggersCount(body.triggers.length);
          setDlqCount(body.dlq_count);
        })
        .catch(() => {});
    }

    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
        <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
          <span>
            {nodesOnline ?? "—"} / {nodesTotal ?? "—"} nodes online
          </span>
          <span>·</span>
          <span>{conversationsCount ?? "—"} conversations</span>
          <span>·</span>
          <span>{triggersCount ?? "—"} triggers</span>
          {dlqCount !== null && dlqCount > 0 ? (
            <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-red-800">
              {dlqCount} dlq
            </span>
          ) : null}
        </div>
      </header>

      <nav className="flex items-center gap-1.5 text-xs" role="tablist">
        {(["conversations", "nodes", "triggers"] as const).map((tab) => (
          <Link
            key={tab}
            href={`/admin/activity/${tab}`}
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
