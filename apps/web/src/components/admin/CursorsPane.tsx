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
 * Generic operator view of plugin-managed work "cursors" — long-running
 * loops a plugin tracks per item (e.g. a PR-iteration loop's per-PR
 * state). Core names no plugin: it discovers panels via
 * `/api/admin/panels` (#284 router mounts) and probes each prefix for the
 * conventional `cursors` + `summary` sub-routes, rendering whatever
 * implements the shape. Pause/resume (and any other state-appropriate
 * action a panel advertises) POST back to the owning plugin.
 */
const STATUS_CLASS: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-800",
  iterating: "bg-indigo-100 text-indigo-800",
  waiting: "bg-amber-100 text-amber-800",
  escalated: "bg-red-100 text-red-800",
  exhausted: "bg-rose-100 text-rose-800",
  done: "bg-muted text-muted-foreground",
};

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
        // Probe every mounted plugin prefix; keep only those that
        // implement the cursors convention (getPanelCursors → null on 404).
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
        long-lived per-item loop contributes its cursors here when installed.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {panels.map((p) => (
        <ProviderSection
          key={p.prefix}
          providerPanel={p}
          onChanged={() => reloadRef.current()}
        />
      ))}
    </div>
  );
}

function ProviderSection({
  providerPanel,
  onChanged,
}: {
  providerPanel: ProviderPanel;
  onChanged: () => void;
}): React.ReactElement {
  const { prefix, panel, summary } = providerPanel;
  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold text-foreground">{panel.label}</h2>
        {summary && summary.stats.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
            {summary.stats.map((s) => (
              <span key={s.label}>
                {s.label}: <span className="text-foreground">{s.value}</span>
              </span>
            ))}
          </div>
        ) : null}
      </header>

      {panel.cursors.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background p-3 text-xs text-muted-foreground">
          No active cursors.
        </p>
      ) : (
        <ul className="flex flex-col rounded-md border border-border bg-background">
          {panel.cursors.map((c) => (
            <li key={c.id}>
              <CursorRow prefix={prefix} cursor={c} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CursorRow({
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
    <article className="flex flex-col gap-1 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            STATUS_CLASS[cursor.status] ?? "bg-muted text-muted-foreground",
          )}
        >
          {cursor.status}
        </span>
        {cursor.paused ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-800">
            held
          </span>
        ) : null}
        {cursor.url ? (
          <a
            href={cursor.url}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate font-medium text-blue-700 underline-offset-2 hover:underline"
          >
            {cursor.title}
          </a>
        ) : (
          <span className="truncate font-medium text-foreground">
            {cursor.title}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {cursor.actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => void run(action)}
              disabled={busy !== null}
              className={cn(
                "rounded-md border border-border bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground",
                busy !== null ? "opacity-50" : "",
              )}
            >
              {busy === action ? "…" : action}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
        {cursor.node_id ? <span>node {cursor.node_id}</span> : null}
        {Object.entries(cursor.detail).map(([k, v]) =>
          v === null || v === undefined ? null : (
            <span key={k}>
              {k}={formatDetail(v)}
            </span>
          ),
        )}
      </div>
      {actionError ? (
        <p className="font-mono text-[10px] text-red-700">{actionError}</p>
      ) : null}
    </article>
  );
}

function formatDetail(value: unknown): string {
  if (typeof value === "string") {
    // ISO timestamps are the common detail value — show local time.
    const ts = Date.parse(value);
    if (!Number.isNaN(ts) && /\d{4}-\d{2}-\d{2}T/.test(value)) {
      return new Date(ts).toLocaleString();
    }
    return value.length > 32 ? `${value.slice(0, 31)}…` : value;
  }
  return String(value);
}
