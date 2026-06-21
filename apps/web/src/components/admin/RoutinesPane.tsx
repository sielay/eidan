// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  listAdminRoutines,
  type RoutineInfo,
  type RoutineRun,
} from "@/lib/api/admin";
import { cn } from "@/lib/utils";

const RUN_STATUS_CLASS: Record<string, string> = {
  delivered: "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200",
  started: "bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200",
  failed: "bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200",
};

/**
 * Read-only list of the operator's recurring routines (eidan.routines) and
 * each one's recent fire history (eidan.routine_runs). Routines are the
 * substrate the amygdala proactive loop runs on, so this pane is also the
 * "is scheduled agent work actually firing — and when did it last run?" view.
 *
 * 15 s poll cadence matches the sibling panes' chrome polling.
 */
export function RoutinesPane(): React.ReactElement {
  const { user } = useAuth();
  const [routines, setRoutines] = React.useState<RoutineInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    function load(): void {
      void listAdminRoutines()
        .then((data) => {
          if (cancelled) return;
          setRoutines(data);
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
      <p className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (routines === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (routines.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
        No routines yet. A routine is a recurring prompt the agent runs on a
        cadence (&ldquo;every morning at 08:00, brief me&rdquo;) — ask in chat to
        schedule one, or the amygdala loop registers its own here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {routines.map((routine) => (
        <li key={routine.id}>
          <RoutineRow routine={routine} />
        </li>
      ))}
    </ul>
  );
}

function RoutineRow({ routine }: { routine: RoutineInfo }): React.ReactElement {
  const lastRun = routine.recent_runs[0] ?? null;
  return (
    <article className="flex flex-col gap-2 rounded-md border border-border bg-background px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            routine.enabled
              ? "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200"
              : "bg-muted text-muted-foreground",
          )}
        >
          {routine.enabled ? "on" : "paused"}
        </span>
        <span className="text-sm font-medium text-foreground">{routine.name}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {routine.schedule}
        </span>
        <span
          className="ml-auto font-mono text-[10px] text-muted-foreground"
          title={routine.last_run_at ?? undefined}
        >
          {routine.last_run_at
            ? `last run ${formatRelative(routine.last_run_at)}`
            : "never run"}
        </span>
      </div>

      <p className="line-clamp-2 text-xs text-muted-foreground">{routine.prompt}</p>

      {routine.recent_runs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {routine.recent_runs.map((run) => (
            <RunChip key={run.fired_for} run={run} />
          ))}
        </div>
      ) : lastRun === null ? (
        <span className="font-mono text-[10px] text-muted-foreground/60">
          no fires recorded yet
        </span>
      ) : null}
    </article>
  );
}

function RunChip({ run }: { run: RoutineRun }): React.ReactElement {
  const title = run.detail
    ? `${run.fired_for} · ${run.status} — ${run.detail}`
    : `${run.fired_for} · ${run.status}`;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 font-mono text-[10px]",
        RUN_STATUS_CLASS[run.status] ?? "bg-muted text-muted-foreground",
      )}
      title={title}
    >
      {run.fired_for}
    </span>
  );
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
