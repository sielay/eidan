// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  getActivitySummary,
  getPanelSummary,
  listAdminPanels,
  type ActivitySummary,
  type ProviderSummary,
  type SummaryWindow,
} from "@/lib/api/admin";
import { cn } from "@/lib/utils";

/**
 * Activity dashboard: at-a-glance graphs + tallies over the window.
 *
 * Core data (agent-turn volume, completed/errored turns, cost, the jobs
 * queue) comes from `/api/admin/summary`; per-plugin loop tallies come
 * from each plugin's `summary` panel (same generic discovery as the
 * Cursors pane), so a bundle's loop stats appear without core naming it.
 * Charts are hand-rolled SVG — the app ships no chart lib, and these
 * stay dependency-free in that spirit.
 */
const WINDOWS: SummaryWindow[] = ["1h", "24h", "7d"];

export function DashboardPane(): React.ReactElement {
  const { user } = useAuth();
  const [window, setWindow] = React.useState<SummaryWindow>("24h");
  const [summary, setSummary] = React.useState<ActivitySummary | null>(null);
  const [providers, setProviders] = React.useState<ProviderSummary[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [core, refs] = await Promise.all([
          getActivitySummary(window),
          listAdminPanels(),
        ]);
        const provSummaries = await Promise.all(
          refs.map((r) => getPanelSummary(r.prefix).catch(() => null)),
        );
        if (cancelled) return;
        setSummary(core);
        setProviders(
          provSummaries.filter((p): p is ProviderSummary => p !== null),
        );
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user, window]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Activity over the selected window. Refreshes every 15s.
        </p>
        <div
          role="tablist"
          aria-label="Time window"
          className="inline-flex rounded-md border border-border bg-background/60 p-0.5 text-[10px]"
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={window === w}
              onClick={() => setWindow(w)}
              className={cn(
                "rounded px-2 py-0.5 font-medium uppercase tracking-wider transition-colors",
                window === w
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {summary === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Turns" value={summary.turn_totals.complete} />
            <Stat
              label="Errors"
              value={summary.turn_totals.error}
              tone={summary.turn_totals.error > 0 ? "warn" : undefined}
            />
            <Stat label="Cost" value={formatUsd(summary.turn_totals.cost_usd)} />
            <Stat
              label="Jobs active"
              value={activeJobs(summary.jobs_by_status)}
            />
          </div>

          <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
            <h2 className="text-xs font-medium text-foreground">
              Agent turns over time
            </h2>
            <Sparkbars
              points={summary.events_by_bucket.map((b) => ({
                label: b.ts,
                value: b.turns,
                alt: b.errors,
              }))}
            />
          </section>

          <div className="grid gap-3 sm:grid-cols-2">
            <BarsCard title="Jobs by status" data={summary.jobs_by_status} />
            <BarsCard title="Jobs by kind" data={summary.jobs_by_kind} />
          </div>

          {providers.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {providers.map((p) => (
                <section
                  key={p.provider}
                  className="flex flex-col gap-2 rounded-md border border-border bg-background p-3"
                >
                  <h2 className="text-xs font-medium text-foreground">
                    {p.label}
                  </h2>
                  {p.stats.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No activity.</p>
                  ) : (
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {p.stats.map((s) => (
                        <div key={s.label} className="flex items-baseline gap-1.5">
                          <span className="font-mono text-sm text-foreground">
                            {s.value}
                          </span>
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {s.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "warn";
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-background p-3">
      <span
        className={cn(
          "font-mono text-lg font-semibold tabular-nums",
          tone === "warn" ? "text-red-600 dark:text-red-400" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/** Horizontal bar list keyed by label — for the jobs-by-X breakdowns. */
function BarsCard({
  title,
  data,
}: {
  title: string;
  data: Record<string, number>;
}): React.ReactElement {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = entries.reduce((m, [, v]) => (v > m ? v : m), 0);
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <h2 className="text-xs font-medium text-foreground">{title}</h2>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map(([label, value]) => (
            <li key={label} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                {label}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded bg-muted">
                <span
                  className="block h-full rounded bg-foreground/60"
                  style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right font-mono tabular-nums text-foreground">
                {value}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Minimal SVG column chart for the time-bucketed turn volume. */
function Sparkbars({
  points,
}: {
  points: { label: string; value: number; alt: number }[];
}): React.ReactElement {
  if (points.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No agent turns in this window.</p>
    );
  }
  const max = points.reduce((m, p) => (p.value > m ? p.value : m), 1);
  const width = 100;
  const height = 32;
  const gap = points.length > 1 ? 1 : 0;
  const barW = (width - gap * (points.length - 1)) / points.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-16 w-full"
      role="img"
      aria-label="Agent turns per time bucket"
    >
      {points.map((p, i) => {
        const h = (p.value / max) * height;
        const x = i * (barW + gap);
        const hasError = p.alt > 0;
        return (
          <rect
            key={p.label}
            x={x}
            y={height - h}
            width={barW}
            height={h}
            className={cn(
              hasError ? "fill-red-500/70" : "fill-foreground/50",
            )}
          >
            <title>
              {new Date(p.label).toLocaleString()}: {p.value} turn
              {p.value === 1 ? "" : "s"}
              {p.alt > 0 ? `, ${p.alt} error${p.alt === 1 ? "" : "s"}` : ""}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

const ACTIVE_JOB_STATUSES = ["queued", "claimed", "running"];

function activeJobs(byStatus: Record<string, number>): number {
  return ACTIVE_JOB_STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
