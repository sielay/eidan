// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  cursorAction,
  getPanelCursors,
  getPanelSummary,
  listAdminPanels,
  type CursorItem,
  type CursorPanel,
  type ProviderSummary,
} from "@/lib/api/admin";
import { cn } from "@/lib/utils";

/**
 * Generic operator board for plugin-managed work "cursors" — long-running
 * loops a plugin tracks per item (e.g. a PR-iteration review loop's per-PR
 * state). Core names no plugin: it discovers panels via `/api/admin/panels`
 * and probes each prefix for the conventional `cursors` + `summary`
 * sub-routes, rendering whatever implements the shape. The rich per-item
 * view (findings by severity, iteration timeline) reads the generic
 * `cursor.detail` bag, so a plugin opts into depth without core knowing it.
 * Pause/resume (and any other action a panel advertises) POST back to the
 * owning plugin.
 */

// status string → {zone, label}. Zones are the visual vocabulary; a plugin's raw status is the key.
// Unknown statuses fall back to neutral so a panel with novel states still renders sensibly.
type Zone = "neutral" | "info" | "warn" | "alert" | "good";
const STATUS: Record<string, { zone: Zone; label: string }> = {
  open: { zone: "neutral", label: "Open" },
  iterating: { zone: "info", label: "Iterating" },
  reviewing: { zone: "info", label: "Reviewing" },
  waiting: { zone: "warn", label: "Waiting" },
  changes: { zone: "warn", label: "Changes requested" },
  escalated: { zone: "alert", label: "Escalated" },
  exhausted: { zone: "alert", label: "Exhausted" },
  done: { zone: "good", label: "Done" },
  approved: { zone: "good", label: "Approved" },
};
function statusOf(s: string): { zone: Zone; label: string } {
  return STATUS[s] ?? { zone: "neutral", label: s };
}

const ZONE_PILL: Record<Zone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-indigo-100 text-indigo-800",
  warn: "bg-amber-100 text-amber-800",
  alert: "bg-red-100 text-red-800",
  good: "bg-emerald-100 text-emerald-800",
};
const ZONE_DOT: Record<Zone, string> = {
  neutral: "bg-muted-foreground/50",
  info: "bg-indigo-500",
  warn: "bg-amber-500",
  alert: "bg-red-500",
  good: "bg-emerald-500",
};
const ZONE_BAR: Record<Zone, string> = {
  neutral: "bg-muted-foreground/40",
  info: "bg-indigo-400",
  warn: "bg-amber-400",
  alert: "bg-red-400",
  good: "bg-emerald-400",
};

const SEV: Record<string, { zone: Zone; label: string }> = {
  blocker: { zone: "alert", label: "Blocker" },
  warning: { zone: "warn", label: "Warning" },
  nit: { zone: "info", label: "Nit" },
};

// ── safe readers for the generic detail bag ─────────────────────────────────────
function str(d: Record<string, unknown>, k: string): string | null {
  return typeof d[k] === "string" ? (d[k] as string) : null;
}
function numOf(d: Record<string, unknown>, k: string): number | null {
  return typeof d[k] === "number" ? (d[k] as number) : null;
}
interface Finding {
  sev: string;
  file: string;
  msg: string;
}
interface TimelineEntry {
  n: number;
  when: string;
  text: string;
}
function findingsOf(d: Record<string, unknown>): Finding[] {
  const f = d["findings"];
  return Array.isArray(f) ? (f as Finding[]).filter((x) => x && typeof x === "object") : [];
}
function timelineOf(d: Record<string, unknown>): TimelineEntry[] {
  const t = d["timeline"];
  return Array.isArray(t) ? (t as TimelineEntry[]).filter((x) => x && typeof x === "object") : [];
}

interface ProviderPanel {
  prefix: string;
  summary: ProviderSummary | null;
  panel: CursorPanel;
}

export function CursorsPane(): React.ReactElement {
  const { user } = useAuth();
  const [panels, setPanels] = React.useState<ProviderPanel[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const reloadRef = React.useRef<() => void>(() => {});

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const refs = await listAdminPanels();
        const settled = await Promise.all(
          refs.map(async (ref) => {
            const panel = await getPanelCursors(ref.prefix).catch(() => null);
            if (panel === null) return null;
            const summary = await getPanelSummary(ref.prefix).catch(() => null);
            return { prefix: ref.prefix, panel, summary } satisfies ProviderPanel;
          }),
        );
        if (cancelled) return;
        setPanels(settled.filter((p): p is ProviderPanel => p !== null));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    reloadRef.current = () => void load();
    void load();
    const id = setInterval(() => void load(), 15_000);
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
  if (panels === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (panels.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
        No plugin exposes a cursor panel on this host. A plugin that runs a
        long-lived per-item loop contributes its board here when installed.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {panels.map((p) => (
        <ProviderBoard
          key={p.prefix}
          providerPanel={p}
          onChanged={() => reloadRef.current()}
        />
      ))}
    </div>
  );
}

function ProviderBoard({
  providerPanel,
  onChanged,
}: {
  providerPanel: ProviderPanel;
  onChanged: () => void;
}): React.ReactElement {
  const { prefix, panel, summary } = providerPanel;
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [repo, setRepo] = React.useState<string>("All");

  const repos = React.useMemo(() => {
    const set = new Set<string>();
    for (const c of panel.cursors) {
      const r = str(c.detail, "repo");
      if (r) set.add(r);
    }
    return ["All", ...[...set].sort()];
  }, [panel.cursors]);

  const shown =
    repo === "All"
      ? panel.cursors
      : panel.cursors.filter((c) => str(c.detail, "repo") === repo);
  const selected = panel.cursors.find((c) => c.id === selectedId) ?? null;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-base font-semibold text-foreground">{panel.label}</h2>
      </header>

      {summary && summary.stats.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          {summary.stats.map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-border bg-background p-3"
            >
              <div className="text-xs text-muted-foreground">{s.label}</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-foreground">
                {s.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {repos.length > 2 ? (
        <div className="flex flex-wrap gap-2">
          {repos.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRepo(r)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                repo === r
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      ) : null}

      {panel.cursors.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background p-6 text-center text-sm text-muted-foreground">
          No active cursors. When the loop picks up an item it appears here with
          its status and progress.
        </p>
      ) : (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <ul className="flex w-full flex-col gap-2 lg:w-[380px] lg:flex-none">
            {shown.map((c) => (
              <li key={c.id}>
                <QueueRow
                  cursor={c}
                  selected={selectedId === c.id}
                  onSelect={() => setSelectedId(c.id)}
                />
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1 lg:border-l lg:border-border lg:pl-6">
            {selected ? (
              <CursorDetail
                prefix={prefix}
                cursor={selected}
                onChanged={onChanged}
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-muted-foreground">
                Select an item to see its review.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function QueueRow({
  cursor,
  selected,
  onSelect,
}: {
  cursor: CursorItem;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const st = statusOf(cursor.status);
  const d = cursor.detail;
  const branch = str(d, "branch");
  const iter = numOf(d, "iteration");
  const esc = numOf(d, "escalations") ?? 0;
  const updated = str(d, "updated");
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-lg border bg-background p-3 text-left transition-colors",
        selected
          ? "border-foreground/40 ring-1 ring-foreground/10"
          : "border-border hover:border-foreground/20",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {cursor.title}
        </span>
        <Pill zone={st.zone} label={st.label} />
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {branch ? <Chip>{branch}</Chip> : null}
        {iter !== null ? <Chip>iter {iter}</Chip> : null}
        {esc > 0 ? (
          <Chip alert>
            {esc} escalation{esc > 1 ? "s" : ""}
          </Chip>
        ) : null}
        {cursor.paused ? <Chip alert>held</Chip> : null}
        {updated ? <span className="ml-auto">· {updated}</span> : null}
      </span>
    </button>
  );
}

function CursorDetail({
  prefix,
  cursor,
  onChanged,
}: {
  prefix: string;
  cursor: CursorItem;
  onChanged: () => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const st = statusOf(cursor.status);
  const d = cursor.detail;
  const findings = findingsOf(d);
  const timeline = timelineOf(d);
  const branch = str(d, "branch");
  const iter = numOf(d, "iteration");
  const grouped = ["blocker", "warning", "nit"]
    .map((sev) => ({ sev, items: findings.filter((f) => f.sev === sev) }))
    .filter((g) => g.items.length);

  async function run(action: string): Promise<void> {
    setBusy(action);
    setActionError(null);
    try {
      await cursorAction(prefix, cursor.id, action);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        {cursor.url ? (
          <a
            href={cursor.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-blue-700 underline-offset-2 hover:underline"
          >
            Open on GitHub ↗
          </a>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {cursor.actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => void run(action)}
              disabled={busy !== null}
              className={cn(
                "rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium capitalize text-muted-foreground transition-colors hover:text-foreground",
                busy !== null ? "opacity-50" : "",
              )}
            >
              {busy === action ? "…" : action}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="font-mono text-xs text-muted-foreground">
          {cursor.title}
        </div>
        <h1 className="mt-0.5 text-lg font-semibold text-foreground">
          {str(d, "title") ?? cursor.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <Pill zone={st.zone} label={st.label} />
          {branch ? <Chip>{branch}</Chip> : null}
          {iter !== null ? <Chip>iteration {iter}</Chip> : null}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-background p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="text-sm font-semibold text-foreground">
            Critic findings
          </div>
          <span className="text-xs text-muted-foreground">
            {findings.length} total
          </span>
        </div>
        {grouped.length === 0 ? (
          <p className="text-xs text-muted-foreground">No findings recorded.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {grouped.map((g) => {
              const sev = SEV[g.sev] ?? { zone: "info" as Zone, label: g.sev };
              return (
                <div key={g.sev} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Pill zone={sev.zone} label={sev.label} />
                    <span className="font-mono text-xs text-muted-foreground">
                      {g.items.length}
                    </span>
                  </div>
                  {g.items.map((f, i) => (
                    <div key={i} className="flex gap-2">
                      <span
                        className={cn(
                          "mt-0.5 w-1 flex-none rounded",
                          ZONE_BAR[sev.zone],
                        )}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {f.file}
                        </span>
                        <span className="text-sm text-foreground">{f.msg}</span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {timeline.length > 0 ? (
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-3 text-sm font-semibold text-foreground">
            Iteration timeline
          </div>
          <div className="flex flex-col gap-3">
            {timeline.map((t, i) => (
              <div key={i} className="flex gap-3">
                <span
                  className={cn(
                    "mt-1.5 h-2 w-2 flex-none rounded-full",
                    ZONE_DOT[st.zone],
                  )}
                />
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">
                    Iteration {t.n}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t.text} · {t.when}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {actionError ? (
        <p className="font-mono text-[11px] text-red-700">{actionError}</p>
      ) : null}
    </div>
  );
}

function Pill({
  zone,
  label,
}: {
  zone: Zone;
  label: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ZONE_PILL[zone],
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", ZONE_DOT[zone])} />
      {label}
    </span>
  );
}

function Chip({
  children,
  alert,
}: {
  children: React.ReactNode;
  alert?: boolean;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
        alert
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
