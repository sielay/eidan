// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import React from "react";
import { cn } from "@/lib/utils";
import type { ToolCatalogEntry } from "@/lib/api/admin";

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface MentionListProps {
  items: ToolCatalogEntry[];
  command: (item: { id: string; label: string }) => void;
}

// The @-mention popover: a keyboard-navigable list of the engine's live tools, each shown by name +
// owning plugin + a dimmed description so an author picks a capability by intent instead of recalling
// its exact identifier. Driven by TipTap's suggestion utility (the parent wires onKeyDown).
export const MentionList = React.forwardRef<MentionListRef, MentionListProps>(function MentionList(
  { items, command },
  ref,
) {
  const [selected, setSelected] = React.useState(0);
  React.useEffect(() => setSelected(0), [items]);

  const pick = React.useCallback(
    (i: number) => {
      const it = items[i];
      if (it) command({ id: it.name, label: it.name });
    },
    [items, command],
  );

  React.useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelected((s) => (s - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          pick(selected);
          return true;
        }
        return false;
      },
    }),
    [items, selected, pick],
  );

  if (items.length === 0) {
    return (
      <div className="w-80 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground shadow-lg">
        no tool matches — keep typing, or press Esc
      </div>
    );
  }

  return (
    <div className="max-h-72 w-80 overflow-auto rounded-md border border-border bg-background py-1 shadow-lg">
      {items.map((it, i) => (
        <button
          key={it.name}
          type="button"
          // onMouseDown (not click) + preventDefault so the editor keeps focus through the selection.
          onMouseDown={(e) => {
            e.preventDefault();
            pick(i);
          }}
          onMouseEnter={() => setSelected(i)}
          className={cn(
            "flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left",
            i === selected ? "bg-accent" : "hover:bg-accent/50",
          )}
        >
          <span className="flex items-baseline gap-1.5">
            <span className="font-mono text-xs text-foreground">@{it.name}</span>
            {it.plugin ? <span className="text-[10px] text-muted-foreground">{it.plugin}</span> : null}
          </span>
          {it.description ? (
            <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{it.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
});
