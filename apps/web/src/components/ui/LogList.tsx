// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { cx, type Zone } from "./cx";

const ZONE_VAR: Record<Zone, string> = {
  good: "var(--good)",
  info: "var(--info)",
  warn: "var(--warn)",
  alert: "var(--alert)",
  neutral: "var(--faint)",
};

/** LogList — compact reverse-chron list (design §3). */
export function LogList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return <div className={cx("loglist", className)}>{children}</div>;
}

/** A single LogList row: zone dot, primary value, secondary meta, optional value. */
export function LogRow({
  zone,
  primary,
  meta,
  value,
  onClick,
}: {
  zone?: Zone;
  primary: React.ReactNode;
  meta?: React.ReactNode;
  value?: React.ReactNode;
  onClick?: () => void;
}): React.ReactElement {
  const interactive = typeof onClick === "function";
  return (
    <div
      className="logrow"
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={interactive ? { cursor: "pointer" } : undefined}
    >
      <span className="logrow__dot" style={{ background: ZONE_VAR[zone ?? "neutral"] }} />
      <div className="logrow__main">
        <div className="logrow__primary">{primary}</div>
        {meta ? <div className="logrow__meta">{meta}</div> : null}
      </div>
      {value != null ? <div className="logrow__value">{value}</div> : null}
    </div>
  );
}
