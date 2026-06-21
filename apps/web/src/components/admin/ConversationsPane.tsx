// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  listConversations,
  type ConversationSummary,
} from "@/lib/api/conversations";

/**
 * "Running and recent" conversations pane.
 *
 * eidan does not have potem's discrete `jobs` table — conversations
 * are the unit of work (docs/024 §intro). For the activity surface we
 * reuse `GET /api/conversations` and render the row in operator-shape:
 * id-first, last-touched relative time, created-at as a tooltip.
 *
 * Node attribution per conversation (which backend instance is
 * driving each turn) is *not* surfaced in Phase 1. The join exists
 * in the data — `eidan.node_events.conversation_id` — but no route
 * aggregates it yet; the cost of adding one for a column the operator
 * may not even want until they go multi-instance is more than the
 * value today. The nodes tab gives operators "what nodes are alive"
 * and the per-node tail gives them "what each one is doing" — those
 * two answer the underlying question between them.
 */
export function ConversationsPane(): React.ReactElement {
  const { user } = useAuth();
  const [rows, setRows] = React.useState<ConversationSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    function load(): void {
      void listConversations()
        .then((data) => {
          if (cancelled) return;
          setRows(data);
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
  if (rows === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No conversations yet — start one from the sidebar.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={`/c/${row.id}`}
            className="flex flex-col gap-1 rounded-md border border-border bg-background p-3 hover:bg-muted"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-medium text-foreground">
                {row.title ?? "Untitled"}
              </span>
              <span
                className="shrink-0 font-mono text-[10px] text-muted-foreground"
                title={new Date(row.updated_at).toLocaleString()}
              >
                {formatRelative(row.updated_at)}
              </span>
            </div>
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {row.id}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
