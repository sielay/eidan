// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { JobDetailDrawer } from "@/components/admin/JobDetailDrawer";
import { jobAction, listAdminJobs, type JobInfo } from "@/lib/api/admin";
import { formatRelative } from "@/lib/format-time";
import { cn } from "@/lib/utils";

type GroupMode = "status" | "node" | "kind";

// Lifecycle lanes for the default (status) grouping. "Active" folds claimed+running.
const STATUS_LANES: { key: string; title: string; statuses: ReadonlySet<string> }[] = [
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

// Retry is for work that didn't finish cleanly; a clean `done` job clones (edit + re-run) instead.
const RETRYABLE = new Set(["failed", "cancelled"]);
const SETTLED = new Set(["done", "failed", "cancelled"]);

interface Column { key: string; title: string; items: JobInfo[] }

function buildColumns(mode: GroupMode, jobs: JobInfo[]): Column[] {
  if (mode === "status") {
    return STATUS_LANES.map((l) => ({ key: l.key, title: l.title, items: jobs.filter((j) => l.statuses.has(j.status)) }));
  }
  const keyOf = (j: JobInfo): string => (mode === "node" ? (j.claimed_by ?? "—") : j.kind || "—");
  const groups = new Map<string, JobInfo[]>();
  for (const j of jobs) {
    const k = keyOf(j);
    const arr = groups.get(k);
    if (arr) arr.push(j);
    else groups.set(k, [j]);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === "—" ? 1 : b[0] === "—" ? -1 : a[0].localeCompare(b[0])))
    .map(([k, items]) => ({ key: k, title: mode === "node" && k === "—" ? "Unclaimed" : k, items }));
}

/**
 * Jobs kanban board (#407). Groups the `eidan.jobs` working set into lanes —
 * by lifecycle status (default), or as swimlanes by node / kind — with a stats
 * strip, per-card actions (retry/clone/archive), and a full-detail slide-over.
 * Shared core surface: any bundle that enqueues jobs (sage, charles) shows here.
 */
export function JobsBoard(): React.ReactElement {
  const { user } = useAuth();
  const [jobs, setJobs] = React.useState<JobInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [startClone, setStartClone] = React.useState(false);
  const [group, setGroup] = React.useState<GroupMode>("status");
  const [showArchived, setShowArchived] = React.useState(false);
  const reloadRef = React.useRef<() => void>(() => {});

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    function load(): void {
      void listAdminJobs({ includeArchived: showArchived })
        .then((rows) => { if (!cancelled) { setJobs(rows); setError(null); } })
        .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    }
    reloadRef.current = load;
    load();
    const id = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user, showArchived]);

  const selected = React.useMemo(() => jobs?.find((j) => j.id === selectedId) ?? null, [jobs, selectedId]);

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

  const columns = buildColumns(group, jobs);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <StatsStrip jobs={jobs} />
        <div className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">group</span>
          {(["status", "node", "kind"] as GroupMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setGroup(m)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] capitalize transition-colors",
                group === m ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
          <label className="ml-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            archived
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {columns.map((col) => (
          <div key={col.key} className="flex min-h-24 flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
            <div className="flex items-baseline justify-between gap-2 px-1">
              <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground" title={col.title}>{col.title}</h3>
              <span className="font-mono text-[10px] text-muted-foreground">{col.items.length}</span>
            </div>
            {col.items.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-muted-foreground/60">—</p>
            ) : (
              col.items.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onOpen={() => { setSelectedId(job.id); setStartClone(false); }}
                  onClone={() => { setSelectedId(job.id); setStartClone(true); }}
                  onReload={() => reloadRef.current()}
                />
              ))
            )}
          </div>
        ))}
      </div>

      <JobDetailDrawer
        job={selected}
        startCloning={startClone}
        onClose={() => { setSelectedId(null); setStartClone(false); }}
        onChanged={() => reloadRef.current()}
      />
    </div>
  );
}

function JobCard({
  job,
  onOpen,
  onClone,
  onReload,
}: {
  job: JobInfo;
  onOpen: () => void;
  onClone: () => void;
  onReload: () => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const title =
    (typeof job.payload?.["title"] === "string" && job.payload["title"]) ||
    job.goal.split("\n")[0] ||
    "(no goal)";
  const hasPr = typeof job.result?.["pr_url"] === "string" || typeof job.result?.["prUrl"] === "string";

  async function act(action: "retry" | "archive" | "unarchive"): Promise<void> {
    setBusy(true);
    try {
      await jobAction(job.id, action);
      onReload();
    } catch {
      /* error surfaces on next poll / drawer; keep the card quiet */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-2 transition-colors hover:border-foreground/30">
      <button type="button" onClick={onOpen} className="flex flex-col gap-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT_CLASS[job.status] ?? "bg-muted-foreground")} />
          <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">{job.kind}</span>
          {hasPr ? <span className="font-mono text-[9px] text-blue-700 dark:text-blue-400">PR</span> : null}
          {job.archived_at ? <span className="font-mono text-[9px] text-muted-foreground/70">archived</span> : null}
          <span className="ml-auto font-mono text-[9px] text-muted-foreground" title={new Date(job.created_at).toLocaleString()}>
            {formatRelative(job.created_at)}
          </span>
        </span>
        <span className="line-clamp-2 text-xs text-foreground">{title}</span>
        {job.surface || job.claimed_by ? (
          <span className="font-mono text-[9px] text-muted-foreground">
            {job.surface ? `via ${job.surface}` : ""}
            {job.claimed_by ? ` · ${job.claimed_by}` : ""}
          </span>
        ) : null}
      </button>
      <div className="flex items-center gap-1">
        {RETRYABLE.has(job.status) ? <CardBtn label="Retry" disabled={busy} onClick={() => void act("retry")} /> : null}
        <CardBtn label="Clone" disabled={busy} onClick={onClone} />
        {job.archived_at ? (
          <CardBtn label="Unarchive" disabled={busy} onClick={() => void act("unarchive")} />
        ) : SETTLED.has(job.status) ? (
          <CardBtn label="Archive" disabled={busy} onClick={() => void act("archive")} />
        ) : null}
      </div>
    </div>
  );
}

function CardBtn({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded border border-border bg-background/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground",
        disabled ? "opacity-50" : "",
      )}
    >
      {label}
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
