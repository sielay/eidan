// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";

import { useAuth } from "@/components/providers/auth-provider";
import * as React from "react";

import {
  listAdminJobs,
  listAdminNodes,
  listAdminRoutines,
  listAdminTriggers,
} from "@/lib/api/admin";
import { listConversations } from "@/lib/api/conversations";
import { cn } from "@/lib/utils";

const ACTIVE_JOB_STATUSES = new Set(["queued", "claimed", "running"]);

/**
 * Tab + counter chrome around the /admin/activity panes
 * (conversations / nodes / triggers / jobs / live).
 *
 * Owns the live polling that drives the banner counts ("X nodes
 * online · Y conversations · Z triggers · N jobs active") so the
 * numbers stay accurate regardless of which tab is in front — a
 * pattern lifted from sibling job-dashboard surfaces where per-pane
 * polling leaves stale counts behind when the user clicks a sibling
 * tab. Each count pulls its pane's full list (the over-fetch is cheap
 * at Phase-1 scale); a rolled-up summary endpoint is a future
 * optimisation across all counts, not just jobs.
 *
 * 15 s cadence: matches the 30 s heartbeat in `docs/024 §3` (two
 * polls per beat is enough to render the freshness dot reliably)
 * while staying cheap on a deployment with a hand-counted plugin
 * count.
 */
const ACTIVITY_TABS = [
  "dashboard",
  "conversations",
  "nodes",
  "triggers",
  "routines",
  "jobs",
  "cursors",
  "log",
  "live",
] as const;

export function ActivityChrome({
  activeTab,
  children,
}: {
  activeTab: (typeof ACTIVITY_TABS)[number];
  children: React.ReactNode;
}): React.ReactElement {
  const { user } = useAuth();
  const [nodesOnline, setNodesOnline] = React.useState<number | null>(null);
  const [nodesTotal, setNodesTotal] = React.useState<number | null>(null);
  const [conversationsCount, setConversationsCount] = React.useState<number | null>(
    null,
  );
  const [triggersCount, setTriggersCount] = React.useState<number | null>(null);
  const [routinesCount, setRoutinesCount] = React.useState<number | null>(null);
  const [dlqCount, setDlqCount] = React.useState<number | null>(null);
  const [jobsActive, setJobsActive] = React.useState<number | null>(null);

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
      void listAdminRoutines()
        .then((rows) => {
          if (cancelled) return;
          setRoutinesCount(rows.filter((r) => r.enabled).length);
        })
        .catch(() => {});
      void listAdminJobs()
        .then((rows) => {
          if (cancelled) return;
          setJobsActive(
            rows.filter((j) => ACTIVE_JOB_STATUSES.has(j.status)).length,
          );
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
          <span>·</span>
          <span>{routinesCount ?? "—"} routines</span>
          <span>·</span>
          <span>{jobsActive ?? "—"} jobs active</span>
          {dlqCount !== null && dlqCount > 0 ? (
            <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-red-800">
              {dlqCount} dlq
            </span>
          ) : null}
        </div>
      </header>

      <nav className="flex items-center gap-1.5 text-xs" role="tablist">
        {ACTIVITY_TABS.map((tab) => (
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
