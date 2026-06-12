// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";

/**
 * ProgressRing — a single-metric ring (design §3). `value` is 0..1.
 * Stroke colour defaults to the brand accent; pass `color` (e.g. a zone var)
 * for a semantic ring.
 */
export function ProgressRing({
  value,
  size = 64,
  stroke = 6,
  color = "var(--accent)",
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - v);
  return (
    <div style={{ position: "relative", width: size, height: size, display: "inline-grid", placeItems: "center" }}>
      <svg className="ring" width={size} height={size} role="img" aria-label={`${Math.round(v * 100)}%`}>
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          stroke={color}
          strokeDasharray={circ}
          strokeDashoffset={offset}
        />
      </svg>
      {children != null ? (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>{children}</div>
      ) : null}
    </div>
  );
}
