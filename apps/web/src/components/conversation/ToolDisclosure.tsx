// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

import type { PairedToolCall } from "./Thread";

/**
 * The "tool work" disclosure pinned in `docs/014 §4.2`: a single
 * fold-down attached to the assistant turn that issued the calls.
 * Closed by default. Opens to per-call cards showing args + result.
 *
 * Eidan persists every call's full ``input`` and every result's full
 * ``content`` (`docs/003 §3`), so the user can audit exactly what the
 * agent asked for and exactly what came back. The card is the
 * user-facing surface of that keen-save promise.
 */
export function ToolDisclosure({
  calls,
}: {
  calls: readonly PairedToolCall[];
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);

  if (calls.length === 0) return null;

  const errors = calls.reduce((n, c) => n + (c.is_error ? 1 : 0), 0);
  const pending = calls.reduce((n, c) => n + (c.result === null ? 1 : 0), 0);
  const summary = summariseNames(calls);

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-dashed border-border/70 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
      >
        <Chevron open={open} />
        <span className="font-medium">
          {calls.length} tool call{calls.length === 1 ? "" : "s"}
        </span>
        {errors > 0 && (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-700 dark:bg-red-950/60 dark:text-red-300">
            {errors} error{errors === 1 ? "" : "s"}
          </span>
        )}
        {pending > 0 && errors === 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
            {pending} pending
          </span>
        )}
        <span className="ml-auto min-w-0 truncate font-mono text-[11px] opacity-80">
          {summary}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border/60 bg-background/60 px-3 py-2">
          {calls.map((c) => (
            <ToolCallCard key={c.id} call={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ call }: { call: PairedToolCall }): React.ReactElement {
  // Errored cards open by default so the user doesn't have to hunt for
  // the failure reason. Successful cards stay collapsed.
  const [open, setOpen] = React.useState(call.is_error);

  const inputSummary = summariseInput(call.input);
  const resultPreview = previewResult(call.result);
  const status = call.is_error ? "error" : call.result === null ? "pending" : "done";

  return (
    <div
      className={cn(
        "overflow-hidden rounded border bg-background",
        call.is_error
          ? "border-red-300 dark:border-red-900"
          : "border-border/80",
      )}
      data-status={status}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
      >
        <StatusBadge status={status} />
        <span className="shrink-0 font-mono">{call.name}</span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
          {inputSummary && (
            <span className="min-w-0 truncate">{inputSummary}</span>
          )}
          {resultPreview && (
            <>
              <span aria-hidden className="opacity-60">→</span>
              <span
                className={cn(
                  "min-w-0 truncate font-mono",
                  call.is_error && "text-red-700 dark:text-red-300",
                )}
              >
                {resultPreview}
              </span>
            </>
          )}
        </span>
        <Chevron open={open} className="ml-auto shrink-0" />
      </button>
      {open && (
        <div className="border-t border-border/60 bg-muted/20">
          <DetailSection
            label="Input"
            copyText={prettyJson(call.input)}
          >
            <Code>{prettyJson(call.input)}</Code>
          </DetailSection>
          {call.result !== null ? (
            <DetailSection
              label={call.is_error ? "Error" : "Result"}
              copyText={call.result}
            >
              <Code error={call.is_error}>{call.result}</Code>
            </DetailSection>
          ) : (
            <DetailSection label="Result">
              <span className="text-[11px] italic text-muted-foreground">
                no result recorded
              </span>
            </DetailSection>
          )}
        </div>
      )}
    </div>
  );
}

function DetailSection({
  label,
  children,
  copyText,
}: {
  label: string;
  children: React.ReactNode;
  copyText?: string;
}): React.ReactElement {
  return (
    <div className="border-t border-border/40 px-2.5 py-2 first:border-t-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        {copyText ? <CopyButton text={copyText} /> : null}
      </div>
      {children}
    </div>
  );
}

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onClick = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      // Browsers expose navigator.clipboard only over secure contexts;
      // a failure here just leaves the operator with the
      // already-visible text to copy by hand, so swallow silently.
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      } catch {
        /* noop */
      }
    },
    [text],
  );

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className={cn(
        "rounded border border-border/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground transition-colors",
        "hover:border-border hover:text-foreground",
        copied && "border-emerald-300 text-emerald-700 dark:text-emerald-300",
      )}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function Code({
  children,
  error,
}: {
  children: React.ReactNode;
  error?: boolean;
}): React.ReactElement {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-snug",
        error ? "text-red-700 dark:text-red-300" : "text-foreground/90",
      )}
    >
      {children}
    </pre>
  );
}

function StatusBadge({
  status,
}: {
  status: "done" | "error" | "pending";
}): React.ReactElement {
  const cls =
    status === "error"
      ? "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300"
      : status === "pending"
        ? "bg-muted text-muted-foreground"
        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        cls,
      )}
    >
      {status}
    </span>
  );
}

function Chevron({
  open,
  className,
}: {
  open: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      className={cn("shrink-0 transition-transform", className)}
      style={{ transform: open ? "rotate(90deg)" : undefined }}
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MAX_SUMMARY_NAMES = 3;
const MAX_SUMMARY_VALUE_CHARS = 48;
const MAX_SUMMARY_FIELDS = 2;
const MAX_RESULT_PREVIEW_CHARS = 80;

function summariseNames(calls: readonly PairedToolCall[]): string {
  const unique = Array.from(new Set(calls.map((c) => c.name)));
  if (unique.length <= MAX_SUMMARY_NAMES) return unique.join(" · ");
  return `${unique.slice(0, MAX_SUMMARY_NAMES).join(" · ")} +${
    unique.length - MAX_SUMMARY_NAMES
  }`;
}

/**
 * Generic per-call summary — picks the first couple of scalar-ish input
 * fields. Tool-specific summaries (e.g. ``Search: <query>``) live in
 * the future plugin renderer surface; for now a generic line is enough
 * to make the collapsed card useful.
 */
function summariseInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).slice(0, MAX_SUMMARY_FIELDS);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${truncate(stringifyScalar(v), MAX_SUMMARY_VALUE_CHARS)}`)
    .join(" · ");
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function previewResult(result: string | null): string {
  if (result === null) return "";
  return truncate(result, MAX_RESULT_PREVIEW_CHARS);
}
