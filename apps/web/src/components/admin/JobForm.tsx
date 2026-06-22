// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { createJob, listAdminNodes, type JobInfo } from "@/lib/api/admin";

export interface JobFormInitial {
  kind: string;
  goal: string;
  payload: Record<string, unknown>;
  target_node: string | null;
  model: string | null;
  provider: string | null;
}

export const BLANK_JOB: JobFormInitial = {
  kind: "code",
  goal: "",
  payload: {},
  target_node: null,
  model: null,
  provider: null,
};

export function jobToInitial(job: JobInfo): JobFormInitial {
  return {
    kind: job.kind,
    goal: job.goal,
    payload: job.payload ?? {},
    target_node: job.target_node,
    model: job.model,
    provider: job.provider,
  };
}

const FIELD = "rounded-md border border-border bg-background p-2 text-sm text-foreground";

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}{hint ? <span className="ml-1 normal-case text-muted-foreground/60">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

/**
 * Create or clone a job. Optional target node / provider / model pin where + how it runs (the engine
 * honours them at claim/run time); blank = any node / handler defaults. Used as a modal for both the
 * board's "New job" button and a card/drawer Clone (pre-filled from the source job).
 */
export function JobForm({
  title,
  initial,
  onCreated,
  onCancel,
}: {
  title: string;
  initial: JobFormInitial;
  onCreated: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [kind, setKind] = React.useState(initial.kind);
  const [goal, setGoal] = React.useState(initial.goal);
  const [node, setNode] = React.useState(initial.target_node ?? "");
  const [provider, setProvider] = React.useState(initial.provider ?? "");
  const [model, setModel] = React.useState(initial.model ?? "");
  const [payloadText, setPayloadText] = React.useState(() => JSON.stringify(initial.payload ?? {}, null, 2));
  const [nodes, setNodes] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void listAdminNodes()
      .then((ns) => { if (!cancelled) setNodes(ns.map((n) => n.node_id)); })
      .catch(() => { /* node list is a nicety; the field still accepts free text via "Any" */ });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent): void { if (e.key === "Escape") onCancel(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

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
      await createJob({
        kind: kind.trim() || "code",
        goal: goal.trim(),
        payload,
        target_node: node || null,
        provider: provider.trim() || null,
        model: model.trim() || null,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onCancel} aria-hidden />
      <div
        role="dialog"
        aria-label={title}
        className="fixed inset-x-0 top-[5vh] z-50 mx-auto flex max-h-[88vh] w-[92%] max-w-2xl flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <button type="button" onClick={onCancel} aria-label="Close" className="rounded-md border border-border px-2 py-0.5 text-sm text-muted-foreground hover:text-foreground">✕</button>
        </div>

        {error ? (
          <p className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">{error}</p>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Labeled label="Kind">
            <input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="code" className={FIELD} />
          </Labeled>
          <Labeled label="Node" hint="(any)">
            <select value={node} onChange={(e) => setNode(e.target.value)} className={FIELD}>
              <option value="">Any node</option>
              {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
              {node && !nodes.includes(node) ? <option value={node}>{node}</option> : null}
            </select>
          </Labeled>
          <Labeled label="Provider" hint="(default)">
            <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. haiku" className={FIELD} />
          </Labeled>
        </div>

        <Labeled label="Model" hint="(default)">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-haiku-4-5-20251001" className={FIELD} />
        </Labeled>

        <Labeled label="Goal">
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={9} className={`${FIELD} font-mono text-[12px]`} />
        </Labeled>

        <Labeled label="Payload (JSON)">
          <textarea value={payloadText} onChange={(e) => setPayloadText(e.target.value)} rows={4} className={`${FIELD} font-mono text-[11px]`} />
        </Labeled>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-md border border-border bg-foreground/90 px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create job"}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
