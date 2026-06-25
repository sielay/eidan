// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { listAdminNodes, type NodeInfo } from "@/lib/api/admin";
import { cn } from "@/lib/utils";

import { NodeTail } from "./NodeTail";

/**
 * Heartbeat list + live event tail for the selected node.
 *
 * Freshness dot follows `docs/024 §1.2` (30 s heartbeat cadence):
 *   ≤ 90 s = green ("two beats ago at worst")
 *   ≤ 600 s = amber ("missed a few; degraded")
 *   > 600 s = red ("gone")
 * The route's `seconds_since` is server-computed so the dot does
 * not depend on the client clock.
 */
export function NodesPane(): React.ReactElement {
  const { user } = useAuth();
  const [nodes, setNodes] = React.useState<NodeInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    function load(): void {
      void listAdminNodes()
        .then((rows) => {
          if (cancelled) return;
          setNodes(rows);
          setError(null);
          // Default selection to the freshest node so the tail
          // panel is populated on first paint. Keeps the operator's
          // current pick across refreshes when still present.
          setSelectedId((prev) => {
            if (prev && rows.some((n) => n.node_id === prev)) return prev;
            return rows[0]?.node_id ?? null;
          });
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
  if (nodes === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (nodes.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
        No nodes have registered yet — the backend upserts into
        eidan.node_heartbeats on boot. Check the Fly app or your Pi
        worker is running and reachable from this Postgres.
      </p>
    );
  }

  const selected = nodes.find((n) => n.node_id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col rounded-md border border-border bg-background">
        {nodes.map((node) => {
          const isSelected = node.node_id === selectedId;
          return (
            <li key={node.node_id}>
              <button
                type="button"
                onClick={() => setSelectedId(node.node_id)}
                aria-pressed={isSelected}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted",
                  isSelected ? "bg-muted" : "",
                )}
              >
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", dotClass(node.seconds_since))}
                  aria-hidden
                />
                <span className="font-mono text-xs text-foreground">
                  {node.node_id}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {node.node_type}
                </span>
                <span
                  className="ml-auto font-mono text-[10px] text-muted-foreground"
                  title={new Date(node.last_seen).toLocaleString()}
                >
                  {formatAgo(node.seconds_since)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {selected ? (
        <>
          <NodePlugins plugins={selected.plugins} />
          <NodeServedKinds servedKinds={selected.served_kinds ?? []} />
          <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
            <header className="flex items-baseline justify-between gap-3">
              <h2 className="font-mono text-xs font-medium text-foreground">
                {selected.node_id} · live tail
              </h2>
              <span className="font-mono text-[10px] text-muted-foreground">
                refreshes every 5s
              </span>
            </header>
            <NodeTail nodeId={selected.node_id} />
          </section>
        </>
      ) : null}
    </div>
  );
}

/**
 * Plugins loaded on the selected node, sourced from
 * `eidan.node_heartbeats.plugins` (issue #52). Per-process: the Pi
 * and a Fly machine can carry different sets after a runtime
 * install, so the operator needs to confirm a deploy actually
 * landed on the node they expect.
 */
function NodePlugins({
  plugins,
}: {
  plugins: NodeInfo["plugins"];
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-xs font-medium text-foreground">
          tools · {plugins.length}
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground">
          as of last heartbeat
        </span>
      </header>
      {plugins.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tools reported. Either the node exposes none, or its process
          predates the heartbeat that reports them — restart the backend to refresh.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {plugins.map((name) => (
            <li
              key={name}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-foreground"
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Job kinds the selected node is built to serve from the eidan.jobs
 * delegation queue, with per-kind capacity (issue #249). Sourced from
 * `eidan.node_heartbeats.served_kinds`, advertised by the node's
 * plugins at activation — the companion to the plugin list above, so
 * an operator can see where live capacity for a kind (e.g. `code`)
 * exists across the fleet.
 */
function NodeServedKinds({
  servedKinds,
}: {
  servedKinds: NonNullable<NodeInfo["served_kinds"]>;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-xs font-medium text-foreground">
          served kinds · {servedKinds.length}
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground">
          as of last heartbeat
        </span>
      </header>
      {servedKinds.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This node serves no delegation-queue kinds — it runs no work claimer
          (EIDAN_JOB_KINDS unset).
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {servedKinds.map((kind) => (
            <li
              key={kind}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-foreground"
            >
              {kind}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function dotClass(secondsSince: number): string {
  if (secondsSince <= 90) return "bg-emerald-500";
  if (secondsSince <= 600) return "bg-amber-500";
  return "bg-red-500";
}

function formatAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
