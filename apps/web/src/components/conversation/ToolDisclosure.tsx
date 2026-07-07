// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";
import { cn } from "@/lib/utils";

import type { PairedToolCall } from "./Thread";

interface ArtifactRef {
  artifact_id: string;
  filename: string;
  format?: string;
}

// Tools that produce downloadable files (e.g. render_deck) return `{ artifacts: [{ artifact_id,
// filename, … }] }`. Parse those out of the result JSON so we can show Open/Download chips.
function parseArtifacts(result: string | null): ArtifactRef[] {
  if (!result) return [];
  try {
    // `artifacts` is the standard key; fall back to `images` (image_generate) so older results render too.
    const j = JSON.parse(result) as { artifacts?: unknown; images?: unknown };
    const list = Array.isArray(j.artifacts) ? j.artifacts : Array.isArray(j.images) ? j.images : [];
    return list
      .map((a) => a as Record<string, unknown>)
      .filter((a) => typeof a["artifact_id"] === "string" && typeof a["filename"] === "string")
      .map((a) => ({ artifact_id: a["artifact_id"] as string, filename: a["filename"] as string, format: a["format"] as string | undefined }));
  } catch {
    return [];
  }
}

// Fetch the artifact WITH the bearer (the route is owner-scoped), then open/download via an object URL
// — so there's never an un-authed public URL. HTML/PDF open inline (a deck renders as slides).
async function openArtifact(id: string, filename: string, download: boolean): Promise<void> {
  const r = await authFetch(`/api/artifacts/${encodeURIComponent(id)}`);
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  if (download) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    window.open(url, "_blank", "noopener");
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const IMG_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const IMAGE_TOOL_RE = /image|img|photo|render/i;
function isImageArtifact(a: ArtifactRef): boolean {
  return (a.format ? /(png|jpe?g|jpeg|gif|webp|avif|svg|image)/i.test(a.format) : false) || IMG_RE.test(a.filename);
}

// Inline image: fetch the artifact WITH the bearer, hold an object-URL for the <img>. `bubble` renders
// it prominently in the message flow (like ChatGPT/Claude) with a download affordance; otherwise small.
function ArtifactImage({ a, bubble }: { a: ArtifactRef; bubble?: boolean }): React.ReactElement {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false; let obj: string | null = null;
    void (async () => {
      try {
        const r = await authFetch(`/api/artifacts/${encodeURIComponent(a.artifact_id)}`);
        if (!r.ok || cancelled) return;
        obj = URL.createObjectURL(await r.blob());
        if (cancelled) { URL.revokeObjectURL(obj); return; }
        setUrl(obj);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; if (obj) URL.revokeObjectURL(obj); };
  }, [a.artifact_id]);
  if (!url) return <div className={cn("animate-pulse rounded-lg bg-muted/40", bubble ? "h-64 w-64 max-w-full" : "h-40 w-40")} />;
  return (
    <figure className="m-0 flex flex-col items-start gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={a.filename} title={`${a.filename} — click to open`} className={cn("cursor-pointer rounded-lg border border-border", bubble ? "max-h-[28rem] max-w-full" : "max-h-72 max-w-full")} onClick={() => void openArtifact(a.artifact_id, a.filename, false)} />
      {bubble ? <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => void openArtifact(a.artifact_id, a.filename, true)}>⤓ Download</button> : null}
    </figure>
  );
}

// A generation placeholder shown while an image tool is still running (result === null) — the snazzy
// shimmer ChatGPT/Claude show. Rendered by ImageResults so it sits in the message flow, not the tool card.
function GenPlaceholder(): React.ReactElement {
  return (
    <div className="my-1 flex h-64 w-64 max-w-full animate-pulse flex-col items-center justify-center gap-2 rounded-lg border border-border bg-gradient-to-br from-muted/50 to-muted/10 text-xs text-muted-foreground">
      <span className="text-2xl">🎨</span>Generating image…
    </div>
  );
}

// Generated images as prominent message bubbles + the generating shimmer. Pulled from the message's
// image-tool calls so they read like a real image reply, separate from the folded tool machinery.
export function ImageResults({ calls }: { calls: PairedToolCall[] }): React.ReactElement | null {
  const nodes: React.ReactNode[] = [];
  calls.forEach((c, i) => {
    if (!IMAGE_TOOL_RE.test(c.name)) return;
    if (c.result === null) { nodes.push(<GenPlaceholder key={`gen-${i}`} />); return; }
    for (const a of parseArtifacts(c.result)) nodes.push(<ArtifactImage key={a.artifact_id} a={a} bubble />);
  });
  if (!nodes.length) return null;
  return <div className="my-2 flex flex-col items-start gap-2">{nodes}</div>;
}

function ArtifactChips({ artifacts, toolName }: { artifacts: ArtifactRef[]; toolName?: string }): React.ReactElement | null {
  // Images render as prominent message bubbles (ImageResults); the tool card keeps only the non-image
  // download chips (decks, PDFs, …). An image tool's outputs are always treated as images.
  const fromImageTool = !!toolName && IMAGE_TOOL_RE.test(toolName);
  const chips = artifacts.filter((a) => !(isImageArtifact(a) || fromImageTool));
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-background/60 px-2.5 py-2">
      {chips.map((a) => (
        <span key={a.artifact_id} className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/40 px-2 py-1 text-[11px]">
          <span className="font-mono">{a.filename}</span>
          <button
            type="button"
            className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider hover:border-border hover:text-foreground"
            onClick={() => void openArtifact(a.artifact_id, a.filename, false)}
          >
            Open
          </button>
          <button
            type="button"
            className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider hover:border-border hover:text-foreground"
            onClick={() => void openArtifact(a.artifact_id, a.filename, true)}
          >
            Download
          </button>
        </span>
      ))}
    </div>
  );
}

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
  const artifacts = parseArtifacts(call.result);

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
      {artifacts.length > 0 && <ArtifactChips artifacts={artifacts} toolName={call.name} />}
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
