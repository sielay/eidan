// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { JobDetailDrawer } from "@/components/admin/JobDetailDrawer";
import { BLANK_JOB, JobForm, jobToInitial, type JobFormInitial } from "@/components/admin/JobForm";
import { jobAction, listAdminJobs, type JobInfo } from "@/lib/api/admin";
import { formatRelative } from "@/lib/format-time";
import { cn } from "@/lib/utils";

type SwimMode = "none" | "node" | "kind" | "agent";

// Status columns are always present; swimlanes split them into horizontal bands per node / kind.
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

const SETTLED = new Set(["done", "failed", "cancelled"]);

interface Band { key: string; title: string; jobs: JobInfo[] }

function buildSwimlanes(mode: SwimMode, jobs: JobInfo[]): Band[] {
  if (mode === "none") return [{ key: "all", title: "", jobs }];
  const keyOf = (j: JobInfo): string =>
    mode === "node" ? (j.claimed_by ?? "—") : mode === "agent" ? (j.agent ?? "—") : j.kind || "—";
  const groups = new Map<string, JobInfo[]>();
  for (const j of jobs) {
    const k = keyOf(j);
    const arr = groups.get(k);
    if (arr) arr.push(j);
    else groups.set(k, [j]);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === "—" ? 1 : b[0] === "—" ? -1 : a[0].localeCompare(b[0])))
    .map(([k, laneJobs]) => ({
      key: k,
      title: k !== "—" ? k : mode === "node" ? "Unclaimed" : mode === "agent" ? "No agent" : "—",
      jobs: laneJobs,
    }));
}

/**
 * Jobs kanban board (#407) — full-bleed lifecycle columns, optionally split into
 * swimlanes per node / kind, with a stats strip, per-card actions (retry/clone/
 * archive), and a full-detail slide-over. Shared core surface (sage, charles).
 */
export function JobsBoard(): React.ReactElement {
  const { user } = useAuth();
  const [jobs, setJobs] = React.useState<JobInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<{ title: string; initial: JobFormInitial } | null>(null);
  const [swimlane, setSwimlane] = React.useState<SwimMode>("none");
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
  const reload = React.useCallback(() => reloadRef.current(), []);
  const openDetail = React.useCallback((id: string) => { setSelectedId(id); }, []);

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

  const openClone = (id: string): void => {
    const j = jobs.find((x) => x.id === id);
    if (j) setForm({ title: "Clone job", initial: jobToInitial(j) });
  };

  const bands = buildSwimlanes(swimlane, jobs);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <StatsStrip jobs={jobs} />
        <button
          type="button"
          onClick={() => setForm({ title: "New job", initial: BLANK_JOB })}
          className="rounded-md border border-border bg-foreground/90 px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          + New job
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">swimlanes</span>
          {(["none", "node", "kind", "agent"] as SwimMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setSwimlane(m)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] capitalize transition-colors",
                swimlane === m ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
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

      <div className="flex flex-col gap-4">
        {bands.map((band) => (
          <div key={band.key} className="flex flex-col gap-1.5">
            {swimlane !== "none" ? (
              <div className="flex items-baseline gap-2 border-b border-border pb-1">
                <h3 className="truncate text-xs font-semibold text-foreground" title={band.title}>{band.title}</h3>
                <span className="font-mono text-[10px] text-muted-foreground">{band.jobs.length}</span>
              </div>
            ) : null}
            <StatusColumns jobs={band.jobs} onOpen={openDetail} onClone={openClone} onReload={reload} />
          </div>
        ))}
      </div>

      <JobDetailDrawer
        job={selected}
        onClone={() => { if (selected) openClone(selected.id); }}
        onClose={() => setSelectedId(null)}
        onChanged={reload}
      />

      {form ? (
        <JobForm
          title={form.title}
          initial={form.initial}
          onCancel={() => setForm(null)}
          onCreated={() => { setForm(null); reload(); }}
        />
      ) : null}
    </div>
  );
}

function StatusColumns({
  jobs,
  onOpen,
  onClone,
  onReload,
}: {
  jobs: JobInfo[];
  onOpen: (id: string) => void;
  onClone: (id: string) => void;
  onReload: () => void;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {STATUS_LANES.map((col) => {
        const items = jobs.filter((j) => col.statuses.has(j.status));
        return (
          <div key={col.key} className="flex min-h-20 flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
            <div className="flex items-baseline justify-between px-1">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{col.title}</h4>
              <span className="font-mono text-[10px] text-muted-foreground">{items.length}</span>
            </div>
            {items.length === 0 ? (
              <p className="px-1 py-1 text-[11px] text-muted-foreground/60">—</p>
            ) : (
              items.map((job) => (
                <JobCard key={job.id} job={job} onOpen={() => onOpen(job.id)} onClone={() => onClone(job.id)} onReload={onReload} />
              ))
            )}
          </div>
        );
      })}
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
        {SETTLED.has(job.status) ? <CardBtn label="Retry" disabled={busy} onClick={() => void act("retry")} /> : null}
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
