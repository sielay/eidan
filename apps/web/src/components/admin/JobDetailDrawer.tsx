// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { createJob, jobAction, type JobInfo } from "@/lib/api/admin";
import { formatAbsolute, formatRelative } from "@/lib/format-time";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<string, string> = {
  queued: "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200",
  claimed: "bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200",
  running: "bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-200",
  done: "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200",
  failed: "bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200",
  cancelled: "bg-muted text-muted-foreground",
};

const CANCELLABLE = new Set(["queued", "claimed", "running"]);
const RETRYABLE = new Set(["done", "failed", "cancelled"]);

// Only surface a worker-supplied result field as a link when it's an http(s)
// URL — guards against a javascript:/data: scheme reaching href.
function safeUrl(v: unknown): string | null {
  return typeof v === "string" && /^https?:\/\//i.test(v) ? v : null;
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Slide-over detail for one `eidan.jobs` row (#407). Surfaces everything the
 * board card can't: the full goal, the delegate payload, the worker result,
 * the error, and the lifecycle timeline — plus the cancel/retry controls. The
 * per-job log stream is Phase 2 (needs a `job_id`-keyed event store on the
 * engine side); until then we link out to what we have.
 */
export function JobDetailDrawer({
  job,
  onClose,
  onChanged,
}: {
  job: JobInfo | null;
  onClose: () => void;
  onChanged: () => void;
}): React.ReactElement | null {
  const [busy, setBusy] = React.useState<null | "cancel" | "retry">(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [cloning, setCloning] = React.useState(false);

  // Reset transient UI when the selected job changes.
  React.useEffect(() => {
    setCloning(false);
    setActionError(null);
  }, [job?.id]);

  // Close on Escape while the drawer is open.
  React.useEffect(() => {
    if (!job) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [job, onClose]);

  if (!job) return null;

  async function run(action: "cancel" | "retry"): Promise<void> {
    if (!job) return;
    setBusy(action);
    setActionError(null);
    try {
      await jobAction(job.id, action);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const prUrl = safeUrl(job.result?.["pr_url"]) ?? safeUrl(job.result?.["prUrl"]);
  const title =
    (typeof job.payload?.["title"] === "string" && job.payload["title"]) || null;
  const durationMs =
    job.claimed_at && job.status === "done"
      ? new Date(job.updated_at).getTime() - new Date(job.claimed_at).getTime()
      : null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Job detail"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-background shadow-xl"
      >
        <header className="sticky top-0 flex items-start gap-2 border-b border-border bg-background px-4 py-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                  STATUS_CLASS[job.status] ?? "bg-muted text-muted-foreground",
                )}
              >
                {job.status}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {job.kind}
              </span>
            </div>
            <h2 className="text-sm font-semibold text-foreground">
              {title ?? "Job " + job.id.slice(0, 8)}
            </h2>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {CANCELLABLE.has(job.status) ? (
              <Action label="Cancel" busy={busy === "cancel"} disabled={busy !== null} onClick={() => void run("cancel")} />
            ) : null}
            {RETRYABLE.has(job.status) ? (
              <Action label="Retry" busy={busy === "retry"} disabled={busy !== null} onClick={() => void run("retry")} />
            ) : null}
            {!cloning ? (
              <Action label="Clone" busy={false} disabled={busy !== null} onClick={() => setCloning(true)} />
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md border border-border px-2 py-0.5 text-sm text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex flex-col gap-4 px-4 py-4 text-sm">
          {actionError ? (
            <p className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">
              {actionError}
            </p>
          ) : null}

          {cloning ? (
            <CloneForm
              job={job}
              onCancel={() => setCloning(false)}
              onCreated={() => { setCloning(false); onChanged(); onClose(); }}
            />
          ) : (<>
          <Field label="Goal">
            <p className="whitespace-pre-wrap text-foreground">{job.goal || "—"}</p>
          </Field>

          <Field label="Timeline">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
              <dt>created</dt><dd title={formatAbsolute(job.created_at)}>{formatRelative(job.created_at)}</dd>
              {job.claimed_at ? (<><dt>claimed</dt><dd title={formatAbsolute(job.claimed_at)}>{formatRelative(job.claimed_at)}{job.claimed_by ? ` · ${job.claimed_by}` : ""}</dd></>) : null}
              <dt>updated</dt><dd title={formatAbsolute(job.updated_at)}>{formatRelative(job.updated_at)}</dd>
              {durationMs !== null ? (<><dt>duration</dt><dd>{Math.round(durationMs / 1000)}s</dd></>) : null}
              {job.surface ? (<><dt>via</dt><dd>{job.surface}</dd></>) : null}
            </dl>
          </Field>

          {prUrl ? (
            <Field label="Pull request">
              <a href={prUrl} target="_blank" rel="noopener noreferrer" className="break-all text-blue-700 underline dark:text-blue-400">
                {prUrl}
              </a>
            </Field>
          ) : null}

          {job.error ? (
            <Field label="Error">
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">{job.error}</pre>
            </Field>
          ) : null}

          {Object.keys(job.payload ?? {}).length > 0 ? (
            <Field label="Payload">
              <JsonBlock value={job.payload} />
            </Field>
          ) : null}

          {Object.keys(job.result ?? {}).length > 0 ? (
            <Field label="Result">
              <JsonBlock value={job.result} />
            </Field>
          ) : null}

          <Field label="Logs">
            <p className="rounded-md border border-dashed border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
              Per-job execution logs aren&apos;t captured yet (#407 Phase 2: a{" "}
              <code className="font-mono">job_id</code>-keyed event stream). For now,
              progress lives in the worker node&apos;s journal and the milestone notify topic.
            </p>
          </Field>
          </>)}
        </div>
      </aside>
    </>
  );
}

// Clone an existing job: pre-fill the goal + payload, let the operator edit, then enqueue a fresh
// job (status='queued'). The original is untouched; this is the "duplicate and schedule" path.
function CloneForm({
  job,
  onCancel,
  onCreated,
}: {
  job: JobInfo;
  onCancel: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const [goal, setGoal] = React.useState(job.goal);
  const [payloadText, setPayloadText] = React.useState(() => prettyJson(job.payload ?? {}));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    if (!goal.trim()) { setError("Goal can't be empty."); return; }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = payloadText.trim() ? JSON.parse(payloadText) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("Payload must be a JSON object."); return;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      setError("Payload is not valid JSON."); return;
    }
    setBusy(true);
    try {
      await createJob({ kind: job.kind, goal: goal.trim(), payload });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Editing a copy of this job — tweak the goal/payload and enqueue a new one. The original is left as-is.
      </p>
      {error ? (
        <p className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">{error}</p>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Goal</span>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={10}
          className="rounded-md border border-border bg-background p-2 font-mono text-[12px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Payload (JSON)</span>
        <textarea
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
          rows={5}
          className="rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-md border border-border bg-foreground/90 px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create job"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Back
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

function JsonBlock({ value }: { value: unknown }): React.ReactElement {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] text-foreground">
      {prettyJson(value)}
    </pre>
  );
}

function Action({
  label,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md border border-border bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground",
        disabled ? "opacity-50" : "",
      )}
    >
      {busy ? "…" : label}
    </button>
  );
}
