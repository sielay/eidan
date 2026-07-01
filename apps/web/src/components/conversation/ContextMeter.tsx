// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { contextWindowFor } from "@/lib/models";
import { cn } from "@/lib/utils";

const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * How full the model's context window is for this conversation. `used` is the latest turn's input
 * context (prompt + cache-read tokens — cached tokens still occupy the window); `model` sizes the bar.
 * Renders nothing until there's a turn to measure.
 */
export function ContextMeter({ used, model }: { used: number; model: string | null }): React.ReactElement | null {
  if (!used || used <= 0) return null;
  const max = contextWindowFor(model);
  const pct = Math.min(100, Math.round((used / max) * 100));
  const tone =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground" title={`Context window: ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)`}>
      <span className="whitespace-nowrap">Context</span>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="whitespace-nowrap font-mono">{fmt(used)}/{fmt(max)} · {pct}%</span>
    </div>
  );
}
