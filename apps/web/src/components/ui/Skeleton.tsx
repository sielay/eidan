// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";
import { cx } from "./cx";

/** Skeleton — shimmering placeholder for loading states (design §3). */
export function Skeleton({
  width,
  height = 16,
  radius,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <div
      className={cx("skel", className)}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden
    />
  );
}
