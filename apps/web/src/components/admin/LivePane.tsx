// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  streamActivityEvents,
  type ActivityEvent,
} from "@/lib/api/activity";
import { cn } from "@/lib/utils";

/**
 * Cross-node live tail of `eidan.node_events` (#155 / docs/014).
 *
 * Opens an SSE-shaped stream against `/api/admin/activity/events`
 * and renders each new event as a card at the top. The cursor
 * resets to "now" on every reconnect, so the operator only sees
 * events from when they opened the page — no replay. To page back
 * through history, the per-node endpoint at
 * `/api/admin/nodes/{id}/events` is the right surface.
 */
const MAX_EVENTS = 200;

interface DisplayEvent extends ActivityEvent {
  /** Stable per-event id for React keys — node_id+seq is unique. */
  key: string;
}

function eventKey(event: ActivityEvent): string {
  return `${event.node_id}:${event.seq}`;
}

const TYPE_TONE: Record<string, string> = {
  "node.boot": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "node.shutdown": "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  "plugin.activate": "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  "dispatcher.started": "bg-purple-500/10 text-purple-700 dark:text-purple-300",
  // `agent.turn.*` (#172 / #174) are the load-bearing rows for
  // observing live agent work — give them their own ramp so they
  // stand apart from the boot / lifecycle noise.
  "agent.turn.start": "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "agent.turn.tool_call": "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  "agent.turn.complete": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "agent.turn.error": "bg-red-500/10 text-red-700 dark:text-red-300",
  // `behaviour.fired` (#179) is the cron / schedule trigger pulse — sentry
  // ticks, git pollers, etc. Distinct ramp so it doesn't blur into
  // `agent.turn.*` but still reads as agent-side scheduled work.
  "behaviour.fired": "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
};

function typeTone(type: string): string {
  return TYPE_TONE[type] ?? "bg-muted text-muted-foreground";
}

function formatUsd(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value === 0) return "$0";
  if (value < 0.0001) return `$${value.toExponential(1)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTs(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString();
  } catch {
    return iso;
  }
}

type TypeFilter = "all" | "agent" | "lifecycle";

function matchesTypeFilter(filter: TypeFilter, type: string): boolean {
  if (filter === "all") return true;
  if (filter === "agent") {
    // `agent.turn.*` and `behaviour.fired` are agent-side work: the operator
    // watching the Agent filter wants to see turn events, errors, and the
    // cron/schedule pulses that kick them off, not boot/shutdown noise.
    return type.startsWith("agent.") || type === "behaviour.fired";
  }
  // "lifecycle" — boot / shutdown / activate / dispatcher.* — i.e. the
  // process / wiring events. Anything not classified as agent above lands
  // here, including future event families we haven't named yet.
  return !type.startsWith("agent.") && type !== "behaviour.fired";
}

const TYPE_FILTER_LABEL: Record<TypeFilter, string> = {
  all: "All",
  agent: "Agent",
  lifecycle: "Lifecycle",
};

export function LivePane(): React.ReactElement {
  const { user, loading } = useAuth();
  const [events, setEvents] = React.useState<DisplayEvent[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [paused, setPaused] = React.useState(false);
  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>("all");
  const [nodeFilter, setNodeFilter] = React.useState<string>("all");
  const pausedRef = React.useRef(false);

  // Set of node ids seen in the current ring buffer. Sorted for a
  // stable filter-button order; "all" always rides at the front.
  const knownNodes = React.useMemo(() => {
    const seen = new Set<string>();
    for (const e of events) seen.add(e.node_id);
    return Array.from(seen).sort();
  }, [events]);

  // If the operator picked a node and then that node's events scroll
  // out of the buffer (or get cleared), reset back to "all" so the
  // counter doesn't get stuck on "0/N".
  React.useEffect(() => {
    if (nodeFilter !== "all" && !knownNodes.includes(nodeFilter)) {
      setNodeFilter("all");
    }
  }, [nodeFilter, knownNodes]);

  const visibleEvents = React.useMemo(
    () =>
      events.filter(
        (e) =>
          matchesTypeFilter(typeFilter, e.type) &&
          (nodeFilter === "all" || e.node_id === nodeFilter),
      ),
    [events, typeFilter, nodeFilter],
  );

  React.useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  React.useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        for await (const event of streamActivityEvents(controller.signal)) {
          if (cancelled) return;
          if (pausedRef.current) continue;
          setConnected(true);
          setEvents((prev) => {
            const next = [{ ...event, key: eventKey(event) }, ...prev];
            return next.slice(0, MAX_EVENTS);
          });
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "stream failed");
        setConnected(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [user]);

  if (loading || !user) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/60 p-4 text-sm text-muted-foreground">
        Sign in to see live activity.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              connected && !paused
                ? "bg-emerald-500"
                : paused
                  ? "bg-amber-500"
                  : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          <span className="text-muted-foreground">
            {paused
              ? "Paused"
              : connected
                ? "Streaming"
                : "Connecting…"}
          </span>
          <span className="text-muted-foreground/60">
            · {visibleEvents.length}/{events.length} event
            {events.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div
            role="tablist"
            aria-label="Filter by event type"
            className="inline-flex rounded-md border border-border bg-background/60 p-0.5 text-[10px]"
          >
            {(["all", "agent", "lifecycle"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={typeFilter === kind}
                onClick={() => setTypeFilter(kind)}
                className={cn(
                  "rounded px-2 py-0.5 font-medium uppercase tracking-wider transition-colors",
                  typeFilter === kind
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {TYPE_FILTER_LABEL[kind]}
              </button>
            ))}
          </div>
          {knownNodes.length > 1 ? (
            <div
              role="tablist"
              aria-label="Filter by node"
              className="inline-flex rounded-md border border-border bg-background/60 p-0.5 text-[10px]"
            >
              <button
                type="button"
                role="tab"
                aria-selected={nodeFilter === "all"}
                onClick={() => setNodeFilter("all")}
                className={cn(
                  "rounded px-2 py-0.5 font-medium uppercase tracking-wider transition-colors",
                  nodeFilter === "all"
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                All
              </button>
              {knownNodes.map((nodeId) => (
                <button
                  key={nodeId}
                  type="button"
                  role="tab"
                  aria-selected={nodeFilter === nodeId}
                  onClick={() => setNodeFilter(nodeId)}
                  title={nodeId}
                  className={cn(
                    "max-w-[90px] truncate rounded px-2 py-0.5 font-mono font-medium uppercase tracking-wider transition-colors",
                    nodeFilter === nodeId
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {nodeId}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            className="rounded-md border border-border bg-background/60 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={() => setEvents([])}
            className="rounded-md border border-border bg-background/60 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
      </div>

      {error !== null ? (
        <div className="rounded-md border border-dashed border-red-300 bg-red-50/40 p-3 text-xs text-red-700 dark:bg-red-950/20">
          {error}
        </div>
      ) : null}

      {events.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background/60 p-4 text-xs text-muted-foreground">
          {connected
            ? "Stream is idle — no events yet. Triggers / boots / activates land here as they happen across every node."
            : "Connecting to the activity stream…"}
        </div>
      ) : visibleEvents.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background/60 p-4 text-xs text-muted-foreground">
          {events.length} event{events.length === 1 ? "" : "s"} in the
          buffer; none match the current filters
          {typeFilter !== "all"
            ? ` (type=${TYPE_FILTER_LABEL[typeFilter]})`
            : ""}
          {nodeFilter !== "all" ? ` (node=${nodeFilter})` : ""}.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visibleEvents.map((event) => (
            <li key={event.key}>
              <EventRow event={event} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventRow({ event }: { event: DisplayEvent }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const hasPayload = Object.keys(event.payload).length > 0;
  const summary =
    event.type === "agent.turn.complete"
      ? summariseTurnComplete(event.payload)
      : summarisePayload(event.payload);

  return (
    <div className="rounded-md border border-border bg-background/40 p-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!hasPayload && event.conversation_id === null}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            typeTone(event.type),
          )}
        >
          {event.type}
        </span>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          {event.node_id}
        </span>
        {summary && (
          <span className="min-w-0 truncate text-muted-foreground">
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatTs(event.ts)}
        </span>
      </button>
      {open && hasPayload ? (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/60 p-2 font-mono text-[11px]">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      ) : null}
      {open && event.conversation_id ? (
        <div className="mt-2 text-[10px] text-muted-foreground">
          <Link
            href={`/c/${event.conversation_id}`}
            className="underline-offset-2 hover:underline"
          >
            open conversation {event.conversation_id.slice(0, 8)}…
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function summariseTurnComplete(payload: Record<string, unknown>): string {
  // Pluck the keys the loop ships on `agent.turn.complete` (#172) and
  // render the operator-meaningful axes first. The generic
  // summarisePayload would truncate `primary_model` and bury cost
  // behind alphabetical order.
  const parts: string[] = [];
  const agent = payload.agent_name;
  if (typeof agent === "string" && agent.length > 0) parts.push(agent);
  const iterations = payload.iterations;
  if (typeof iterations === "number") parts.push(`${iterations} iter`);
  const tools = payload.tool_uses_seen;
  if (typeof tools === "number" && tools > 0) parts.push(`${tools} tool`);
  const cost = formatUsd(payload.cost_usd);
  if (cost !== null) parts.push(cost);
  return parts.join(" · ");
}

function summarisePayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).slice(0, 2);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${stringifyScalar(v)}`)
    .join(" · ");
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") {
    return value.length > 32 ? `${value.slice(0, 31)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json.length > 32 ? `${json.slice(0, 31)}…` : json;
}
