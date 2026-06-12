// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { type Zone } from "./cx";

const ZONE_VAR: Record<Zone, string> = {
  good: "var(--good)",
  info: "var(--info)",
  warn: "var(--warn)",
  alert: "var(--alert)",
  neutral: "var(--faint)",
};

export interface TrendSeries {
  data: number[];
  /** Stroke colour; defaults to the brand accent for the first series. */
  color?: string;
  /** Light filled area under the line (only sensible for one series). */
  area?: boolean;
}

/**
 * TrendChart — the one restrained chart style (design §2/§3): thin lines, muted
 * gridlines, single accent per series, ≤2 series, optional zone bands. Pure SVG,
 * mobile-legible; width is fluid, height fixed (~180–220px).
 */
export function TrendChart({
  series,
  height = 200,
  bands,
  pad = 6,
  className,
}: {
  series: TrendSeries[];
  height?: number;
  bands?: Array<{ from: number; to: number; zone: Zone }>;
  pad?: number;
  className?: string;
}): React.ReactElement {
  const W = 320; // viewBox width; the SVG scales to its container
  const H = height;
  const all = series.flatMap((s) => s.data).filter((n) => Number.isFinite(n));
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const span = hi - lo || 1;
  const y = (v: number): number => H - pad - ((v - lo) / span) * (H - pad * 2);
  const x = (i: number, n: number): number => (n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2));

  const path = (data: number[]): string =>
    data
      .filter((n) => Number.isFinite(n))
      .map((v, i, arr) => `${i === 0 ? "M" : "L"}${x(i, arr.length).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");

  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label="trend chart"
    >
      {/* zone bands */}
      {bands?.map((b, i) => (
        <rect
          key={i}
          x={0}
          y={y(b.to)}
          width={W}
          height={Math.max(0, y(b.from) - y(b.to))}
          fill={ZONE_VAR[b.zone]}
          opacity={0.1}
        />
      ))}
      {/* muted baseline gridlines (min + max only — no chart-junk) */}
      <line x1={0} x2={W} y1={y(hi)} y2={y(hi)} stroke="var(--border)" strokeWidth={1} />
      <line x1={0} x2={W} y1={y(lo)} y2={y(lo)} stroke="var(--border)" strokeWidth={1} />
      {/* series */}
      {series.map((s, i) => {
        const color = s.color ?? (i === 0 ? "var(--accent)" : "var(--info)");
        const d = path(s.data);
        return (
          <g key={i}>
            {s.area ? (
              <path d={`${d} L${x(s.data.length - 1, s.data.length).toFixed(1)},${H - pad} L${pad},${H - pad} Z`} fill={color} opacity={0.08} />
            ) : null}
            <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
}
