// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import React from "react";
import type { ToolCatalogEntry, ToolParamSchema } from "@/lib/api/admin";
import type { MentionParams } from "./persona-tiptap";

type Scalar = string | number | boolean | undefined;

// Render one schema property as the right human control: enum → select, boolean → checkbox,
// number → number input, object/array → JSON textarea, else → text.
function Field({ schema, value, onChange }: { schema: ToolParamSchema; value: Scalar; onChange: (v: Scalar) => void }): React.ReactElement {
  const cls = "w-full rounded border border-border bg-background px-1.5 py-0.5 text-xs";
  if (schema.enum && schema.enum.length) {
    return (
      <select className={cls} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">—</option>
        {schema.enum.map((o) => (
          <option key={String(o)} value={String(o)}>{String(o)}</option>
        ))}
      </select>
    );
  }
  if (schema.type === "boolean") {
    return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />;
  }
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <input
        type="number"
        className={cls}
        value={value === undefined ? "" : Number(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    );
  }
  if (schema.type === "object" || schema.type === "array") {
    return (
      <textarea
        className={cls}
        rows={2}
        placeholder="JSON value"
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
    );
  }
  return <input type="text" className={cls} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)} />;
}

// A per-tool param editor driven by the tool's JSON input schema — so a non-technical author codifies
// a tool call (e.g. job_cursor action=get, job=thinker) by filling fields, not writing call syntax.
export function MentionParamForm({
  tool,
  params,
  onChange,
  onClose,
}: {
  tool: ToolCatalogEntry;
  params: MentionParams;
  onChange: (p: MentionParams) => void;
  onClose: () => void;
}): React.ReactElement {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const keys = Object.keys(props);

  const set = (k: string, v: Scalar): void => {
    const next: MentionParams = { ...params };
    if (v === undefined || v === "") delete next[k];
    else next[k] = v;
    onChange(next);
  };

  return (
    <div className="w-80 rounded-md border border-border bg-background p-2 shadow-lg">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-foreground">@{tool.name}</span>
        <button type="button" onClick={onClose} className="text-[11px] text-muted-foreground hover:text-foreground">
          done
        </button>
      </div>
      {tool.description ? <p className="mb-1.5 text-[10px] leading-snug text-muted-foreground">{tool.description}</p> : null}
      {keys.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">This tool takes no parameters — it&apos;ll be called as the agent sees fit.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {keys.map((k) => {
            const sch = props[k] ?? {};
            return (
              <label key={k} className="flex flex-col gap-0.5">
                <span className="text-[11px] font-medium text-foreground">
                  {k}
                  {required.has(k) ? <span className="text-red-500"> *</span> : null}
                </span>
                <Field schema={sch} value={params[k]} onChange={(v) => set(k, v)} />
                {sch.description ? <span className="text-[10px] leading-snug text-muted-foreground">{sch.description}</span> : null}
              </label>
            );
          })}
        </div>
      )}
      <p className="mt-1.5 border-t border-border pt-1 text-[10px] text-muted-foreground">
        Leave a field blank to let the agent decide it at run time.
      </p>
    </div>
  );
}
