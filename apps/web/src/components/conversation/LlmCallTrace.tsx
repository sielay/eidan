// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import {
  listConversationLlmCalls,
  type LlmCallRow,
} from "@/lib/api/llm-calls";
import { cn } from "@/lib/utils";

/**
 * Per-conversation LLM-call trace panel (#152 / docs/014).
 *
 * Lists every `eidan.llm_calls` row for the conversation in
 * chronological order. Each row shows the role chip, model, latency,
 * tokens, cost, and a click-to-expand block with the system prompt +
 * user-text excerpt the call site stashed via
 * `capture_call_inputs`. Errored rows are highlighted.
 *
 * Mounts behind a toggle in :class:`ConversationView`'s header so the
 * default conversation view stays uncluttered; operators flip it on
 * when they want to debug a turn.
 */
export interface LlmCallTraceProps {
  conversationId: string;
  /** Bumped by the parent after a turn lands so the trace refetches. */
  refreshKey: number;
}

const ROLE_TONE: Record<string, string> = {
  primary: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  scope_classifier: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  intent_classifier: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  sizer: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
  critic: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  failure_classifier: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  behaviour_classifier: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  subagent: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  summariser: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
  tool_synthesis: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
  plugin_tool: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
  embed: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
  other: "bg-muted text-muted-foreground",
};

function roleTone(role: string): string {
  return ROLE_TONE[role] ?? "bg-muted text-muted-foreground";
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return `$${usd.toExponential(1)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function LlmCallTrace({
  conversationId,
  refreshKey,
}: LlmCallTraceProps): React.ReactElement {
  const [rows, setRows] = React.useState<LlmCallRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    (async () => {
      try {
        const data = await listConversationLlmCalls(conversationId);
        if (cancelled) return;
        setRows(data);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "failed to load trace");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshKey]);

  if (error !== null) {
    return (
      <div className="rounded-md border border-dashed border-red-300 bg-red-50/40 p-3 text-xs text-red-700 dark:bg-red-950/20">
        {error}
      </div>
    );
  }
  if (rows === null) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
        Loading trace…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
        No LLM calls recorded for this conversation.
      </div>
    );
  }

  return (
    <section
      data-slot="llm-call-trace"
      className="flex flex-col gap-2"
      aria-label="LLM call trace"
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {rows.length} LLM call{rows.length === 1 ? "" : "s"}
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id}>
            <LlmCallRowView row={row} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function LlmCallRowView({ row }: { row: LlmCallRow }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const systemPrompt = asString(row.metadata.system_prompt);
  const userExcerpt = asString(row.metadata.user_text_excerpt);
  const hasError = row.error !== null;

  const tokens = (
    <span className="font-mono text-[10px] text-muted-foreground">
      {row.input_tokens}↓/{row.output_tokens}↑
    </span>
  );

  return (
    <div
      className={cn(
        "rounded-md border bg-background/40 p-2 text-xs",
        hasError
          ? "border-red-400/60 bg-red-50/30 dark:bg-red-950/10"
          : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            roleTone(row.role),
          )}
        >
          {row.role}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {row.model}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {tokens}
          <span className="font-mono text-[10px] text-muted-foreground">
            {formatLatency(row.latency_ms)}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {formatCost(row.cost_usd)}
          </span>
          <span
            aria-hidden
            className={cn(
              "text-[10px] text-muted-foreground transition-transform",
              open ? "rotate-90" : "",
            )}
          >
            ▸
          </span>
        </span>
      </button>

      {open ? (
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
          {hasError ? (
            <div className="rounded border border-red-300 bg-red-100/40 p-2 text-[11px] text-red-800 dark:bg-red-950/20">
              <div className="font-medium">
                {row.error_type ?? "error"}
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono">
                {row.error}
              </pre>
            </div>
          ) : null}
          {systemPrompt !== null ? (
            <details className="rounded border border-border bg-background/60 p-2">
              <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                system prompt ({systemPrompt.length} chars)
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                {systemPrompt}
              </pre>
            </details>
          ) : null}
          {userExcerpt !== null ? (
            <details className="rounded border border-border bg-background/60 p-2">
              <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                user text excerpt
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                {userExcerpt}
              </pre>
            </details>
          ) : null}
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            <span>provider</span>
            <span className="font-mono">{row.provider}</span>
            <span>started</span>
            <span className="font-mono">{row.started_at}</span>
            {row.message_id ? (
              <>
                <span>message</span>
                <span className="font-mono">{row.message_id.slice(0, 8)}…</span>
              </>
            ) : null}
            {row.request_id ? (
              <>
                <span>request</span>
                <span className="font-mono">{row.request_id}</span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
