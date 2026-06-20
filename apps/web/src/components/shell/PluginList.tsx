// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  listPlugins,
  type NodeIdentity,
  type PluginSummary,
} from "@/lib/api/plugins";
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
  const [node, setNode] = React.useState<NodeIdentity | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await listPlugins();
        if (cancelled) return;
        setPlugins(res.plugins);
        setNode(res.node);
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
    <div className="flex flex-col gap-8">
      {node ? (
        <div className="text-xs text-muted-foreground/70">
          Plugins on{" "}
          <span className="font-medium text-muted-foreground">
            {node.node_id}
          </span>
        </div>
      ) : null}
      {grouped.map(({ tier, rows }) => (
        <section key={tier} className="flex flex-col gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
            {tier}
            <span className="ml-1.5 text-muted-foreground/50">
              ({rows.length})
            </span>
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => (
              <PluginCard key={row.name} row={row} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PluginCard({ row }: { row: PluginSummary }): React.ReactElement {
  return (
    <Link
      href={`/plugins/${row.name}`}
      className={cn(
        "group flex flex-col gap-2 rounded-lg border border-border bg-background p-4",
        "transition hover:border-foreground/30 hover:shadow-sm",
        !row.enabled && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-foreground">{row.display_name}</span>
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {row.tier}
        </span>
      </div>
      <p className="line-clamp-3 text-sm text-muted-foreground">
        {row.description ?? "No description provided yet."}
      </p>
      <div className="mt-auto flex items-center gap-3 pt-1 text-[11px] text-muted-foreground/80">
        {row.enabled ? (
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            enabled
          </span>
        ) : (
          <span className="rounded border border-dashed border-border px-1.5 py-0.5 uppercase tracking-wider">
            available
          </span>
        )}
        {row.version ? <span className="font-mono">v{row.version}</span> : null}
        {typeof row.tool_count === "number" && row.tool_count > 0 ? (
          <span>
            {row.tool_count} tool{row.tool_count === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

