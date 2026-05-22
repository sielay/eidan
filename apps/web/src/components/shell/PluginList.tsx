"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { listPlugins, type PluginSummary } from "@/lib/api/plugins";
import { groupByTier } from "@/lib/plugin-grouping";
import { cn } from "@/lib/utils";

/**
 * Sidebar "Plugins" section content (`docs/014 §10` — the
 * ``plugin-nav`` slot, today filled with the host's read-only list).
 *
 * Reads ``GET /api/plugins`` once on sign-in. The list is metadata about
 * the host install (operator-level, not per-user), but the route is
 * authenticated like every other non-config endpoint, so we wait for a
 * user before fetching.
 *
 * This is the Phase-1 surface: a static, grouped-by-tier list. Phase-4
 * plugin frontends (`docs/001 §3.1`) replace this with actual nav
 * entries injected by individual plugins.
 */
export function PluginList(): React.ReactElement {
  const { config, user, loading } = useAuth();

  const [plugins, setPlugins] = React.useState<PluginSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listPlugins();
        if (cancelled) return;
        setPlugins(rows);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "failed to load plugins");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, user]);

  if (loading || !user) {
    return (
      <div
        data-slot="plugin-nav"
        className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground"
      >
        Sign in to see installed plugins.
      </div>
    );
  }

  if (error !== null) {
    return (
      <div
        data-slot="plugin-nav"
        className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-red-600"
      >
        {error}
      </div>
    );
  }

  if (plugins === null) {
    return (
      <div
        data-slot="plugin-nav"
        className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground"
      >
        Loading…
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <div
        data-slot="plugin-nav"
        className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground"
      >
        No plugins installed.
      </div>
    );
  }

  // Stable tier order: core (always present) → pro → commercial.
  const grouped = groupByTier(plugins);

  return (
    <div data-slot="plugin-nav" className="flex flex-col gap-3">
      {grouped.map(({ tier, rows }) => (
        <section key={tier} className="flex flex-col gap-1">
          <h3 className="px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {tier}
          </h3>
          <ul className="flex flex-col gap-0.5">
            {rows.map((row) => (
              <li key={row.name}>
                <PluginRow row={row} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PluginRow({ row }: { row: PluginSummary }): React.ReactElement {
  return (
    <div
      title={row.description ?? undefined}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs",
        "text-muted-foreground",
      )}
    >
      <span className="truncate text-foreground">{row.display_name}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
        v{row.version}
      </span>
    </div>
  );
}

