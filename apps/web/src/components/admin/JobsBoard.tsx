// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { JobDetailDrawer } from "@/components/admin/JobDetailDrawer";
import { listAdminJobs, type JobInfo } from "@/lib/api/admin";
import { formatRelative } from "@/lib/format-time";
import { cn } from "@/lib/utils";

// Kanban lanes over the eidan.jobs lifecycle. "Active" folds claimed+running
// (a node has it); the terminal failure states share a lane.
const COLUMNS: { key: string; title: string; statuses: ReadonlySet<string> }[] = [
  { key: "queued", title: "Queued", statuses: new Set(["queued"]) },
  { key: "active", title: "Active", statuses: new Set(["claimed", "running"]) },
  { key: "done", title: "Done", statuses: new Set(["done"]) },
  { key: "failed", title: "Failed", statuses: new Set(["failed", "cancelled"]) },
];

const DOT_CLASS: Record<string, string> = {
  queued: "bg-amber-500",
  claimed: "bg-blue-500",
  running: "bg-indigo-500",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-muted-foreground",
};

/**
 * Jobs kanban board (#407) — the richer companion to the flat `JobsPane`.
 * Groups the `eidan.jobs` working set into lifecycle lanes, shows a stats
 * strip (counts + success rate), and opens a full-detail slide-over per job
 * (goal / payload / result / error / timeline / actions). Shared core surface:
 * any bundle that enqueues jobs (sage, charles) shows up here unchanged.
 */
export function JobsBoard(): React.ReactElement {
  const { user } = useAuth();
  const [jobs, setJobs] = React.useState<JobInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const reloadRef = React.useRef<() => void>(() => {});

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    function load(): void {
      void listAdminJobs()
        .then((rows) => {
          if (cancelled) return;
          setJobs(rows);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    }
    reloadRef.current = load;
    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user]);

  // Resolve the selected job against the freshest snapshot so the drawer
  // reflects status changes from the poll without re-opening.
  const selected = React.useMemo(
    () => jobs?.find((j) => j.id === selectedId) ?? null,
    [jobs, selectedId],
  );

  if (error) {
    return (
      <p className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (jobs === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <StatsStrip jobs={jobs} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const items = jobs.filter((j) => col.statuses.has(j.status));
          return (
            <div key={col.key} className="flex min-h-24 flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
              <div className="flex items-baseline justify-between px-1">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{col.title}</h3>
                <span className="font-mono text-[10px] text-muted-foreground">{items.length}</span>
              </div>
              {items.length === 0 ? (
                <p className="px-1 py-2 text-[11px] text-muted-foreground/60">—</p>
              ) : (
                items.map((job) => (
                  <JobCard key={job.id} job={job} onOpen={() => setSelectedId(job.id)} />
                ))
              )}
            </div>
          );
        })}
      </div>
      <JobDetailDrawer
        job={selected}
        onClose={() => setSelectedId(null)}
        onChanged={() => reloadRef.current()}
      />
    </div>
  );
}

function JobCard({ job, onOpen }: { job: JobInfo; onOpen: () => void }): React.ReactElement {
  const title =
    (typeof job.payload?.["title"] === "string" && job.payload["title"]) ||
    job.goal.split("\n")[0] ||
    "(no goal)";
  const hasPr =
    typeof job.result?.["pr_url"] === "string" || typeof job.result?.["prUrl"] === "string";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1 rounded-md border border-border bg-background p-2 text-left transition-colors hover:border-foreground/30"
    >
      <div className="flex items-center gap-1.5">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT_CLASS[job.status] ?? "bg-muted-foreground")} />
        <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">{job.kind}</span>
        {hasPr ? <span className="font-mono text-[9px] text-blue-700 dark:text-blue-400">PR</span> : null}
        <span className="ml-auto font-mono text-[9px] text-muted-foreground" title={new Date(job.created_at).toLocaleString()}>
          {formatRelative(job.created_at)}
        </span>
      </div>
      <span className="line-clamp-2 text-xs text-foreground">{title}</span>
      {job.surface || job.claimed_by ? (
        <span className="font-mono text-[9px] text-muted-foreground">
          {job.surface ? `via ${job.surface}` : ""}
          {job.claimed_by ? ` · ${job.claimed_by}` : ""}
        </span>
      ) : null}
    </button>
  );
}

function StatsStrip({ jobs }: { jobs: JobInfo[] }): React.ReactElement {
  const counts = jobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});
  const done = counts["done"] ?? 0;
  const failed = (counts["failed"] ?? 0) + (counts["cancelled"] ?? 0);
  const settled = done + failed;
  const successRate = settled > 0 ? Math.round((done / settled) * 100) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-background px-3 py-2 text-xs">
      <Stat label="total" value={String(jobs.length)} />
      <Stat label="queued" value={String(counts["queued"] ?? 0)} />
      <Stat label="active" value={String((counts["claimed"] ?? 0) + (counts["running"] ?? 0))} />
      <Stat label="done" value={String(done)} />
      <Stat label="failed" value={String(failed)} />
      {successRate !== null ? <Stat label="success" value={`${successRate}%`} /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-semibold text-foreground">{value}</span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </span>
  );
}
