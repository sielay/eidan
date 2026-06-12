// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cx } from "./cx";

/**
 * Delta — colour ALWAYS paired with an arrow + the value (never colour alone),
 * per the design's accessibility rule.
 */
export function Delta({
  value,
  direction,
}: {
  value: React.ReactNode;
  direction: "good" | "alert" | "muted";
}): React.ReactElement {
  return (
    <span className={cx("delta", `delta--${direction}`)}>
      {direction === "good" ? <ArrowUp /> : direction === "alert" ? <ArrowDown /> : null}
      {value}
    </span>
  );
}

/**
 * StatTile — the atom of every dashboard (design §3): label + big tabular
 * number + optional unit + optional delta/sparkline foot.
 */
export function StatTile({
  label,
  value,
  unit,
  hero,
  delta,
  foot,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  hero?: boolean;
  delta?: React.ReactNode;
  foot?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cx("stat", className)}>
      <div className="stat__label">{label}</div>
      <div className={cx("stat__value", hero && "stat__value--hero")}>
        {value}
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </div>
      {delta || foot ? (
        <div className="stat__foot">
          {delta}
          {foot}
        </div>
      ) : null}
    </div>
  );
}
