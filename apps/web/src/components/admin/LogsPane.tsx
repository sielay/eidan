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
 * Searchable table view of the cross-node `eidan.node_events` stream.
 *
 * The companion to the `live` card-wall: same SSE source
 * (`/api/admin/activity/events`), but rendered as a dense, scannable
 * table with a free-text filter across type / node / conversation /
 * payload. The card wall is good for *watching*; this is good for
 * *finding* — "show me every `agent.turn.error` on the Pi" is one search
 * box away. Newest row on top; click a row to expand its payload.
 *
 * Like the live pane the buffer is a ring of the last MAX_ROWS events
 * from when the page opened (no replay) — to page back through history,
 * the per-node `/admin/activity/nodes` tail is the right surface.
 */
const MAX_ROWS = 500;

interface Row extends ActivityEvent {
  key: string;
}

function rowKey(event: ActivityEvent): string {
  return `${event.node_id}:${event.seq}`;
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

const TYPE_TONE: Record<string, string> = {
  "node.boot": "text-emerald-600 dark:text-emerald-400",
  "node.shutdown": "text-rose-600 dark:text-rose-400",
  "plugin.activate": "text-blue-600 dark:text-blue-400",
  "agent.turn.start": "text-amber-600 dark:text-amber-400",
  "agent.turn.tool_call": "text-cyan-600 dark:text-cyan-400",
  "agent.turn.complete": "text-emerald-600 dark:text-emerald-400",
  "agent.turn.error": "text-red-600 dark:text-red-400",
  "behaviour.fired": "text-indigo-600 dark:text-indigo-400",
};

function typeTone(type: string): string {
  return TYPE_TONE[type] ?? "text-foreground";
}

/** Flatten an event to one lowercased haystack for the search box. */
function haystack(event: ActivityEvent): string {
  return [
    event.type,
    event.node_id,
    event.conversation_id ?? "",
    JSON.stringify(event.payload),
  ]
    .join(" ")
    .toLowerCase();
}

export function LogsPane(): React.ReactElement {
  const { user, loading } = useAuth();
  const [rows, setRows] = React.useState<Row[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [paused, setPaused] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const pausedRef = React.useRef(false);

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
          setRows((prev) =>
            [{ ...event, key: rowKey(event) }, ...prev].slice(0, MAX_ROWS),
          );
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

  const needle = query.trim().toLowerCase();
  const visible = React.useMemo(() => {
    if (needle.length === 0) return rows;
    return rows.filter((r) => haystack(r).includes(needle));
  }, [rows, needle]);

  if (loading || !user) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/60 p-4 text-sm text-muted-foreground">
        Sign in to see activity.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search type, node, conversation, payload…"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus:border-foreground/40"
            aria-label="Search events"
          />
        </div>
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
          <span className="font-mono text-[10px] text-muted-foreground">
            {visible.length}/{rows.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setPaused((v) => !v)}
          className="rounded-md border border-border bg-background/60 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={() => setRows([])}
          className="rounded-md border border-border bg-background/60 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      </div>

      {error !== null ? (
        <div className="rounded-md border border-dashed border-red-300 bg-red-50/40 p-3 text-xs text-red-700 dark:bg-red-950/20">
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background/60 p-4 text-xs text-muted-foreground">
          {connected
            ? "Stream is idle — events land here as they happen across every node."
            : "Connecting to the activity stream…"}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background/60 p-4 text-xs text-muted-foreground">
          {rows.length} event{rows.length === 1 ? "" : "s"} in the buffer;
          none match “{query}”.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">Time</th>
                <th className="px-2 py-1.5 font-medium">Node</th>
                <th className="px-2 py-1.5 font-medium">Type</th>
                <th className="px-2 py-1.5 font-medium">Conversation</th>
                <th className="px-2 py-1.5 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <LogRow key={row.key} event={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LogRow({ event }: { event: Row }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const hasPayload = Object.keys(event.payload).length > 0;
  const detail = summarisePayload(event.payload);

  return (
    <>
      <tr
        className={cn(
          "border-t border-border/60 align-top",
          hasPayload ? "cursor-pointer hover:bg-muted/40" : "",
        )}
        onClick={hasPayload ? () => setOpen((v) => !v) : undefined}
      >
        <td className="whitespace-nowrap px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {formatTs(event.ts)}
        </td>
        <td className="whitespace-nowrap px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {event.node_id}
        </td>
        <td
          className={cn(
            "whitespace-nowrap px-2 py-1 font-mono font-medium",
            typeTone(event.type),
          )}
        >
          {event.type}
        </td>
        <td className="whitespace-nowrap px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {event.conversation_id ? (
            <Link
              href={`/c/${event.conversation_id}`}
              className="underline-offset-2 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {event.conversation_id.slice(0, 8)}
            </Link>
          ) : (
            <span className="text-muted-foreground/40">—</span>
          )}
        </td>
        <td className="max-w-[24rem] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {detail || (hasPayload ? "{…}" : "")}
        </td>
      </tr>
      {open && hasPayload ? (
        <tr className="border-t border-border/40 bg-background/60">
          <td colSpan={5} className="px-2 py-2">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/60 p-2 font-mono text-[11px]">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function summarisePayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).slice(0, 4);
  return entries
    .map(([k, v]) => `${k}=${stringifyScalar(v)}`)
    .join("  ");
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") {
    return value.length > 40 ? `${value.slice(0, 39)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json.length > 40 ? `${json.slice(0, 39)}…` : json;
}
