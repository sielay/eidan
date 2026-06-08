// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { listAdminJobs, type JobInfo } from "@/lib/api/admin";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<string, string> = {
  queued: "bg-amber-100 text-amber-800",
  claimed: "bg-blue-100 text-blue-800",
  running: "bg-indigo-100 text-indigo-800",
  done: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-muted text-muted-foreground",
};

/**
 * Read-only snapshot of the eidan.jobs delegation queue (#251) — the
 * companion to the Nodes pane's served-kinds advertisement (#249): see
 * what's queued / claimed / running / done / failed, which node claimed
 * each job, and why a job failed. The route powering this pane lives in
 * `apps/backend/eidan_backend/http/routes.py:list_jobs_endpoint`; the
 * schema is `core/admin/JobList.schema.json`. Newest first, capped
 * server-side — a working-set view, not full history.
 */
export function JobsPane(): React.ReactElement {
  const { user } = useAuth();
  const [jobs, setJobs] = React.useState<JobInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user]);

  if (error) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        {error}
      </p>
    );
  }
  if (jobs === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (jobs.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
        No jobs in the delegation queue. A <code className="font-mono">delegate</code>{" "}
        enqueues a job keyed by capability kind; a node serving that kind with
        spare capacity claims and runs it.
      </p>
    );
  }

  return (
    <ul className="flex flex-col rounded-md border border-border bg-background">
      {jobs.map((job) => (
        <li key={job.id}>
          <JobRow job={job} />
        </li>
      ))}
    </ul>
  );
}

function JobRow({ job }: { job: JobInfo }): React.ReactElement {
  // result is worker-controlled, so only surface it as a link when it's an
  // http(s) URL — guards against a javascript:/data: scheme reaching href.
  const prUrl =
    typeof job.result?.pr_url === "string" &&
    /^https?:\/\//i.test(job.result.pr_url)
      ? job.result.pr_url
      : null;
  return (
    <article className="flex flex-col gap-1 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            STATUS_CLASS[job.status] ?? "bg-muted text-muted-foreground",
          )}
        >
          {job.status}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {job.kind}
        </span>
        <span className="truncate text-foreground">{job.goal}</span>
        <span
          className="ml-auto font-mono text-[10px] text-muted-foreground"
          title={new Date(job.created_at).toLocaleString()}
        >
          {formatRelative(job.created_at)}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-2 font-mono text-[10px] text-muted-foreground">
        {job.surface ? <span>via {job.surface}</span> : null}
        {job.claimed_by ? <span>· node {job.claimed_by}</span> : null}
        {prUrl ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-700 underline"
          >
            {prUrl}
          </a>
        ) : null}
        {job.error ? (
          <span className="text-red-700" title={job.error}>
            · {truncate(job.error, 160)}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
