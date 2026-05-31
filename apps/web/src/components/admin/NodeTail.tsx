// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { listNodeEvents, type NodeEvent } from "@/lib/api/admin";

const MAX_EVENTS = 50;
const POLL_INTERVAL_MS = 5_000;

/**
 * Live event tail backed by `GET /api/admin/nodes/{id}/events`
 * (docs/024 §5.2). Polls every 5 s using `after_seq` so steady
 * state is the empty-200 case — cheap on the wire.
 *
 * `after_seq` is reset to 0 whenever the prop `nodeId` changes so
 * switching nodes doesn't accidentally miss events past the
 * previous node's last seq.
 */
export function NodeTail({ nodeId }: { nodeId: string }): React.ReactElement {
  const [events, setEvents] = React.useState<NodeEvent[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const afterSeqRef = React.useRef<number>(0);

  React.useEffect(() => {
    let cancelled = false;
    afterSeqRef.current = 0;
    setEvents([]);
    setError(null);

    function tick(): void {
      void listNodeEvents(nodeId, { afterSeq: afterSeqRef.current })
        .then((body) => {
          if (cancelled) return;
          if (body.events.length === 0) return;
          const maxSeq = body.events.reduce(
            (m, e) => (e.seq > m ? e.seq : m),
            afterSeqRef.current,
          );
          afterSeqRef.current = maxSeq;
          // The route returns DESC when no conversation filter is
          // applied, so the freshest row is first. We keep the
          // newest MAX_EVENTS overall, with the newest at the top.
          setEvents((prev) => {
            const next = [...body.events, ...prev];
            return next.slice(0, MAX_EVENTS);
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    }

    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nodeId]);

  if (error) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 p-2 font-mono text-xs text-red-700">
        {error}
      </p>
    );
  }
  if (events.length === 0) {
    return (
      <p className="font-mono text-xs text-muted-foreground">
        Waiting for the next event…
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-1 font-mono text-[11px]">
      {events.map((event) => (
        <li
          key={event.id}
          className="flex flex-wrap items-baseline gap-2 border-b border-dashed border-border/60 pb-1 last:border-b-0"
        >
          <span
            className="text-muted-foreground/70"
            title={new Date(event.ts).toISOString()}
          >
            {new Date(event.ts).toLocaleTimeString()}
          </span>
          <span className="text-foreground">{event.type}</span>
          {event.conversation_id ? (
            <span className="text-muted-foreground/70">
              conv {event.conversation_id.slice(0, 8)}
            </span>
          ) : null}
          {Object.keys(event.payload).length > 0 ? (
            <span className="text-muted-foreground truncate">
              {JSON.stringify(event.payload)}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
