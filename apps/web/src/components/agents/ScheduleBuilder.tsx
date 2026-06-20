// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { isValidSchedule } from "@/lib/schedule";

// Emits a schedule string in the exact grammar isValidSchedule (and the engine) accept:
//   interval — "every 5 minutes" · "every 2 hours" · "hourly" · "every minute"
//   clock    — "09:00" · "mon,fri 17:30"
// One-click presets cover the common cases; "Custom" opens a structured builder so no one has to
// recall the syntax.

const PRESETS: Array<{ label: string; value: string }> = [
  { label: "Off", value: "" },
  { label: "5 min", value: "every 5 minutes" },
  { label: "15 min", value: "every 15 minutes" },
  { label: "Hourly", value: "hourly" },
  { label: "Daily 09:00", value: "09:00" },
  { label: "Weekdays 09:00", value: "mon,tue,wed,thu,fri 09:00" },
];

const DAYS: Array<{ key: string; label: string }> = [
  { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }, { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" }, { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" }, { key: "sun", label: "Sun" },
];

interface Parsed {
  mode: "interval" | "clock";
  n: number;
  unit: "minutes" | "hours";
  time: string;
  days: string[];
}

function parse(value: string): Parsed {
  const txt = value.trim().toLowerCase();
  if (txt === "hourly") return { mode: "interval", n: 1, unit: "hours", time: "09:00", days: [] };
  const iv = txt.match(/^every\s+(\d+)?\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (iv) {
    const n = iv[1] ? Number(iv[1]) : 1;
    const unit = /^h/.test(iv[2] ?? "m") ? "hours" : "minutes";
    return { mode: "interval", n, unit, time: "09:00", days: [] };
  }
  const cl = txt.match(/^(?:([a-z,]+)\s+)?(\d{1,2}:\d{2})$/);
  if (cl) {
    const days = cl[1] ? cl[1].split(",").filter((d) => DAYS.some((x) => x.key === d)) : [];
    return { mode: "clock", n: 5, unit: "minutes", time: cl[2] ?? "09:00", days };
  }
  return { mode: "interval", n: 5, unit: "minutes", time: "09:00", days: [] };
}

function build(p: Parsed): string {
  if (p.mode === "interval") {
    if (p.unit === "hours" && p.n === 1) return "hourly";
    return `every ${p.n} ${p.unit}`;
  }
  const ds = p.days.length ? `${DAYS.filter((d) => p.days.includes(d.key)).map((d) => d.key).join(",")} ` : "";
  return `${ds}${p.time}`;
}

export function ScheduleBuilder({ value, onChange }: { value: string; onChange: (s: string) => void }): React.ReactElement {
  const matchesPreset = PRESETS.some((p) => p.value === value);
  const [custom, setCustom] = React.useState(!matchesPreset && value !== "");
  const [draft, setDraft] = React.useState<Parsed>(() => parse(value || "every 5 minutes"));

  const emit = (next: Parsed): void => {
    setDraft(next);
    const s = build(next);
    onChange(isValidSchedule(s) ? s : "");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => { setCustom(false); onChange(p.value); }}
            className={cn(
              "rounded border px-2 py-0.5 text-[11px]",
              !custom && value === p.value ? "border-foreground bg-foreground text-background" : "border-border hover:bg-muted",
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setCustom((c) => !c); if (!custom) emit(draft); }}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px]",
            custom ? "border-foreground bg-foreground text-background" : "border-border hover:bg-muted",
          )}
        >
          Custom…
        </button>
      </div>

      {custom ? (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1.5">
          <div className="flex overflow-hidden rounded border border-border text-[11px]">
            {(["interval", "clock"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => emit({ ...draft, mode: m })}
                className={cn("px-2 py-0.5", draft.mode === m ? "bg-foreground text-background" : "bg-background hover:bg-muted")}
              >
                {m === "interval" ? "Every…" : "At a time"}
              </button>
            ))}
          </div>

          {draft.mode === "interval" ? (
            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">every</span>
              <input
                type="number" min={1} value={draft.n}
                onChange={(e) => emit({ ...draft, n: Math.max(1, Number(e.target.value) || 1) })}
                className="w-14 rounded border border-border bg-background px-1.5 py-0.5"
              />
              <select
                value={draft.unit}
                onChange={(e) => emit({ ...draft, unit: e.target.value as Parsed["unit"] })}
                className="rounded border border-border bg-background px-1 py-0.5"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">at</span>
              <input
                type="time" value={draft.time}
                onChange={(e) => emit({ ...draft, time: e.target.value || "09:00" })}
                className="rounded border border-border bg-background px-1.5 py-0.5"
              />
              <span className="ml-1 flex gap-0.5">
                {DAYS.map((d) => {
                  const on = draft.days.includes(d.key);
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => emit({ ...draft, days: on ? draft.days.filter((x) => x !== d.key) : [...draft.days, d.key] })}
                      className={cn("rounded px-1 py-0.5 text-[10px]", on ? "bg-foreground text-background" : "bg-background border border-border hover:bg-muted")}
                      title={d.label}
                    >
                      {d.label[0]}
                    </button>
                  );
                })}
              </span>
              <span className="text-[10px] text-muted-foreground">{draft.days.length === 0 ? "every day" : ""}</span>
            </div>
          )}

          <span className="ml-auto font-mono text-[10px] text-muted-foreground">{build(draft) || "—"}</span>
        </div>
      ) : null}
    </div>
  );
}
