// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";
import { cx, type Zone } from "./cx";

/**
 * ZonePill — semantic zone indicator. Colour + label always together
 * (design §3): a coloured dot + text, never colour as the only signal.
 */
export function ZonePill({
  zone = "neutral",
  children,
  className,
}: {
  zone?: Zone;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <span className={cx("pill", `pill--${zone}`, className)}>
      <span className="pill__dot" />
      {children}
    </span>
  );
}
