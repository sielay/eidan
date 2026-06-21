// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  listAdminTriggers,
  type TriggerInfo,
  type TriggerListResponse,
} from "@/lib/api/admin";
import { cn } from "@/lib/utils";

const KIND_CLASS: Record<string, string> = {
  cron: "bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200",
  schedule: "bg-indigo-100 text-indigo-800",
  event: "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200",
  webhook: "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200",
  intent: "bg-purple-100 text-purple-800",
  agent: "bg-fuchsia-100 text-fuchsia-800",
};

/**
 * Read-only snapshot of the in-process behaviour registry plus a
 * pending-DLQ count. The route powering this pane lives in
 * `apps/backend/eidan_backend/http/routes.py:list_triggers_endpoint`;
 * the schema is `core/admin/TriggerList.schema.json`.
 *
 * "Last fire" intentionally absent — see the TriggerList schema's
 * description for the reasoning (registry doesn't record it; adding
 * a column just for one pane is more cost than value).
 */
export function TriggersPane(): React.ReactElement {
  const { user } = useAuth();
  const [body, setBody] = React.useState<TriggerListResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    function load(): void {
      void listAdminTriggers()
        .then((data) => {
          if (cancelled) return;
          setBody(data);
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
  if (body === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (body.triggers.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
        No behaviours registered. Plugins register behaviours on activation —
        if your manifest declares one but nothing shows here, the dispatcher
        probably has not finished booting (check the backend log).
      </p>
    );
  }

  const sorted = [...body.triggers].sort((a, b) =>
    a.behaviour_id.localeCompare(b.behaviour_id),
  );

  return (
    <div className="flex flex-col gap-3">
      {body.dlq_count > 0 ? (
        <p className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-2 text-xs text-red-800 dark:text-red-200">
          {body.dlq_count} pending DLQ row{body.dlq_count === 1 ? "" : "s"} —
          drill in via <code className="font-mono">psql</code> or
          <code className="font-mono">{` SELECT * FROM eidan.behaviour_dlq WHERE status = 'pending'`}</code>.
        </p>
      ) : null}

      <ul className="flex flex-col rounded-md border border-border bg-background">
        {sorted.map((trigger) => (
          <li key={trigger.behaviour_id}>
            <TriggerRow trigger={trigger} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TriggerRow({ trigger }: { trigger: TriggerInfo }): React.ReactElement {
  return (
    <article className="flex flex-wrap items-baseline gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <span
        className={cn(
          "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
          KIND_CLASS[trigger.kind] ?? "bg-muted text-muted-foreground",
        )}
      >
        {trigger.kind}
      </span>
      <span className="font-mono text-xs text-foreground">
        {trigger.behaviour_id}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {trigger.spec}
      </span>
      {trigger.next_run_ts ? (
        <span
          className="ml-auto font-mono text-[10px] text-muted-foreground"
          title={new Date(trigger.next_run_ts).toLocaleString()}
        >
          next: {formatRelative(trigger.next_run_ts)}
        </span>
      ) : (
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
          {trigger.kind === "event" || trigger.kind === "webhook"
            ? "on demand"
            : "not scheduled"}
        </span>
      )}
    </article>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((then - Date.now()) / 1000);
  if (seconds < 0) return "due";
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86_400)}d`;
}
