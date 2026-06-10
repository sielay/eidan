"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { fetchCostSummary, type CostSummary } from "@/lib/api/cost";

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * The thin running-totals row above the conversation transcript
 * (`docs/010 §6`, `docs/014 §4.4`).
 *
 * Three counters share one component because they share one wire shape
 * (``GET /api/cost/summary?scope=…``) and one update cadence story:
 *
 * - **Turn**  — updated immediately after the SSE ``complete`` event by
 *   bumping ``turnRefreshKey`` and (when known) handing the parent's
 *   ``lastMessageId`` in. The endpoint defaults to the user's latest
 *   user message id when none is supplied per `docs/010 §8.1`.
 * - **Session** / **Day** — polled on a fixed interval (default 30s)
 *   per the issue brief; the user window is "since this JWT was
 *   issued" (`docs/010 §6.3`).
 *
 * Render shape (per the issue): a single row of dollar values, tokens
 * exposed via ``title`` hover. The header chrome from `docs/014 §4.4`'s
 * mockup (the ``/ $cap`` budget cap suffix, the day-counter colour
 * thresholds) is left for the budget-config follow-up.
 */
export interface CostCounterProps {
  /** Anchor message id for the per-turn rollup. Optional — the backend
   *  falls back to the user's latest user message when omitted. */
  lastMessageId?: string | null;
  /** Bumped by the parent after every SSE ``complete`` event so the
   *  per-turn counter re-fetches against the freshly-committed row. */
  turnRefreshKey?: number;
  /** Override the per-user / per-day poll interval (ms). */
  pollIntervalMs?: number;
}

export function CostCounter({
  lastMessageId,
  turnRefreshKey = 0,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: CostCounterProps): React.ReactElement | null {
  const { config, user } = useAuth();

  const [turn, setTurn] = React.useState<CostSummary | null>(null);
  const [sessionSummary, setSessionSummary] =
    React.useState<CostSummary | null>(null);
  const [day, setDay] = React.useState<CostSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Per-turn counter — re-fetches whenever the parent signals a turn
  // completed or the anchor message id changes.
  React.useEffect(() => {
    if (!config || !user) return;
    const ctrl = new AbortController();
    fetchCostSummary("turn", {
      messageId: lastMessageId ?? null,
      signal: ctrl.signal,
    })
      .then((summary) => setTurn(summary))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "turn cost unavailable");
      });
    return () => ctrl.abort();
  }, [config, user, lastMessageId, turnRefreshKey]);

  // Session + day — polled together so they stay roughly in sync.
  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    const ctrl = new AbortController();

    const tick = async (): Promise<void> => {
      try {
        const [s, d] = await Promise.all([
          fetchCostSummary("session", { signal: ctrl.signal }),
          fetchCostSummary("day", { signal: ctrl.signal }),
        ]);
        if (cancelled) return;
        setSessionSummary(s);
        setDay(d);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(
          err instanceof Error ? err.message : "session/day cost unavailable",
        );
      }
    };

    void tick();
    const handle = window.setInterval(() => {
      void tick();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearInterval(handle);
    };
  }, [config, user, pollIntervalMs]);

  if (!user) return null;

  return (
    <div
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground"
      data-testid="cost-counter"
    >
      <CounterChip label="today" summary={day} />
      <span aria-hidden="true">•</span>
      <CounterChip label="this session" summary={sessionSummary} />
      <span aria-hidden="true">•</span>
      <CounterChip label="last turn" summary={turn} />
      {error ? (
        <span className="ml-auto text-[11px] text-red-600/80">{error}</span>
      ) : null}
    </div>
  );
}

function CounterChip({
  label,
  summary,
}: {
  label: string;
  summary: CostSummary | null;
}): React.ReactElement {
  const value = summary ? formatUsd(summary.cost_usd) : "—";
  const title = summary
    ? `${summary.input_tokens.toLocaleString()} in · ${summary.output_tokens.toLocaleString()} out`
    : undefined;
  return (
    <span
      className="font-mono tabular-nums"
      title={title}
      data-cost-label={label}
    >
      <span className="text-foreground">{value}</span>
      <span className="ml-1 text-muted-foreground">{label}</span>
    </span>
  );
}

function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
