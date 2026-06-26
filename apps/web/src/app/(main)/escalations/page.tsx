// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  acknowledgeEscalation,
  listEscalations,
  resolveEscalation,
  respondEscalation,
  type EscalationStatusFilter,
  type EscalationSummary,
} from "@/lib/api/escalations";
import { cn } from "@/lib/utils";

/**
 * Operator inbox for `eidan.escalations` (docs/022 §3).
 *
 * Lists every escalation an agent / behaviour / Sentry tick has
 * emitted; the operator advances each through
 * pending → acknowledged → resolved. Filter chip controls which
 * status bucket renders.
 *
 * Severity colouring follows the audit's "no surprises" rule —
 * red for high, amber for medium, neutral for low — so a glance
 * tells the operator whether the inbox needs attention.
 */
export default function EscalationsPage(): React.ReactElement {
  const { config, user, loading } = useAuth();
  const [filter, setFilter] = React.useState<EscalationStatusFilter>("pending");
  const [rows, setRows] = React.useState<EscalationSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await listEscalations({ status: filter });
        if (cancelled) return;
        setRows(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "failed to load escalations",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, user, filter, refreshKey]);

  const handleAcknowledge = async (id: string): Promise<void> => {
    if (!config) return;
    try {
      await acknowledgeEscalation(id);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ack failed");
    }
  };

  const handleResolve = async (id: string): Promise<void> => {
    if (!config) return;
    try {
      await resolveEscalation(id);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "resolve failed");
    }
  };

  const handleRespond = async (id: string, feedback: string, decision?: string): Promise<void> => {
    if (!config || !feedback.trim()) return;
    try {
      await respondEscalation(id, { feedback: feedback.trim(), decision });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "respond failed");
    }
  };

  if (loading || !user) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Escalations</h1>
        <p className="text-sm text-muted-foreground">
          Sign in to see what the agent has flagged.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Escalations</h1>
        <span className="text-xs text-muted-foreground">
          {rows ? `${rows.length} row${rows.length === 1 ? "" : "s"}` : ""}
        </span>
      </header>

      <nav className="flex items-center gap-1.5 text-xs">
        {(["pending", "acknowledged", "resolved", "all"] as const).map(
          (option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              className={cn(
                "rounded-md border px-2 py-1 capitalize",
                filter === option
                  ? "border-foreground/30 bg-muted text-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              {option}
            </button>
          ),
        )}
      </nav>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to surface in this bucket.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id}>
              <EscalationRow
                row={row}
                onAcknowledge={() => void handleAcknowledge(row.id)}
                onResolve={() => void handleResolve(row.id)}
                onRespond={(feedback, decision) => void handleRespond(row.id, feedback, decision)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EscalationRow({
  row,
  onAcknowledge,
  onResolve,
  onRespond,
}: {
  row: EscalationSummary;
  onAcknowledge: () => void;
  onResolve: () => void;
  onRespond: (feedback: string, decision?: string) => void;
}): React.ReactElement {
  const [showRespond, setShowRespond] = React.useState(false);
  const [feedback, setFeedback] = React.useState("");
  const [decision, setDecision] = React.useState("");

  const handleRespondClick = () => {
    if (feedback.trim()) {
      onRespond(feedback, decision || undefined);
      setFeedback("");
      setDecision("");
      setShowRespond(false);
    }
  };

  const severityClass =
    row.severity === "high"
      ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
      : row.severity === "medium"
        ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
        : "border-border bg-background";
  // V2 escalations use from_agent; legacy rows fall back to metadata.source
  const agentLabel = row.from_agent
    ? `from ${row.from_agent}`
    : typeof row.metadata?.source === "string"
      ? `from ${row.metadata.source as string}`
      : null;

  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded-md border p-3 text-sm",
        severityClass,
      )}
    >
      <header className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            row.severity === "high"
              ? "bg-red-200 text-red-800 dark:bg-red-900/50 dark:text-red-200"
              : row.severity === "medium"
                ? "bg-amber-200 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
                : "bg-muted text-muted-foreground",
          )}
        >
          {row.severity}
        </span>
        <span className="font-mono text-[10px]">{row.reason_class}</span>
        {row.escalation_type && row.escalation_type !== "agent_to_operator" ? (
          <span className="font-mono text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 px-1.5 py-0.5 rounded">
            {row.escalation_type.replace(/_/g, " ")}
          </span>
        ) : null}
        {agentLabel ? (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {agentLabel}
          </span>
        ) : null}
        <span className="ml-auto">{formatRelative(row.created_at)}</span>
      </header>
      {row.suggested_action ? (
        <p className="whitespace-pre-wrap text-foreground">
          {row.suggested_action}
        </p>
      ) : null}
      {row.evidence.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">evidence</summary>
          <ul className="mt-1 list-disc pl-5">
            {row.evidence.map((ev, idx) => (
              <li key={idx} className="font-mono">
                {evidenceText(ev)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {row.response ? (
        <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded p-2 text-xs">
          <p className="font-semibold text-blue-900 dark:text-blue-300">Response:</p>
          <p className="text-blue-800 dark:text-blue-200">{row.response.feedback}</p>
          {row.response.decision && (
            <p className="text-blue-700 dark:text-blue-300 text-[10px]">
              Decision: <span className="font-mono">{row.response.decision}</span>
            </p>
          )}
          {row.response.reasoning && (
            <p className="text-blue-700 dark:text-blue-300 text-[10px]">
              Reasoning: {row.response.reasoning}
            </p>
          )}
        </div>
      ) : null}
      {showRespond && row.status !== "responded" ? (
        <div className="bg-muted/30 border border-border rounded p-2 gap-2 flex flex-col">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Your feedback..."
            className="w-full p-2 text-xs border border-border rounded bg-background"
            rows={2}
          />
          <input
            type="text"
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            placeholder="Decision (optional)"
            className="w-full p-2 text-xs border border-border rounded bg-background"
          />
          <div className="flex gap-1">
            <button
              type="button"
              onClick={handleRespondClick}
              disabled={!feedback.trim()}
              className="rounded-md border border-green-600 bg-green-600 text-white px-2 py-1 text-xs hover:bg-green-700 disabled:opacity-50"
            >
              Send Response
            </button>
            <button
              type="button"
              onClick={() => {
                setShowRespond(false);
                setFeedback("");
                setDecision("");
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <footer className="flex items-center gap-2 text-xs">
        {row.status === "pending" ? (
          <button
            type="button"
            onClick={onAcknowledge}
            className="rounded-md border border-border bg-background px-2 py-1 hover:bg-muted"
          >
            Acknowledge
          </button>
        ) : null}
        {row.status !== "resolved" && row.status !== "responded" ? (
          <button
            type="button"
            onClick={() => setShowRespond(!showRespond)}
            className="rounded-md border border-blue-600 text-blue-600 bg-background px-2 py-1 hover:bg-blue-50 dark:hover:bg-blue-950/20"
          >
            Respond
          </button>
        ) : null}
        {row.status !== "resolved" ? (
          <button
            type="button"
            onClick={onResolve}
            className="rounded-md border border-border bg-background px-2 py-1 hover:bg-muted"
          >
            Resolve
          </button>
        ) : (
          <span className="text-muted-foreground">
            resolved{row.resolved_at ? ` ${formatRelative(row.resolved_at)}` : ""}
          </span>
        )}
        <span className="ml-auto text-muted-foreground capitalize">
          status: {row.status}
        </span>
      </footer>
    </article>
  );
}

// Evidence is typed string[] but legacy/auto-escalated rows store jsonb objects
// (e.g. {error, fire_key}). Rendering an object as a React child throws #31, so
// coerce anything non-string to readable text (prefer a .error field if present).
function evidenceText(ev: unknown): string {
  if (typeof ev === "string") return ev;
  if (ev && typeof ev === "object") {
    const e = (ev as { error?: unknown }).error;
    if (typeof e === "string") return e;
    try {
      return JSON.stringify(ev);
    } catch {
      return String(ev);
    }
  }
  return String(ev);
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const delta = now - then;
    const seconds = Math.floor(delta / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86_400)}d ago`;
  } catch {
    return iso;
  }
}
