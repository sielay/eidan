// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";
import { cx } from "./cx";

/**
 * Card — quiet container (design §3). Title row (optional action) + body.
 * No heavy border; subtle elevation unless `flat`.
 */
export function Card({
  title,
  action,
  flat,
  className,
  children,
  ...rest
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  flat?: boolean;
  className?: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div className={cx("card", flat && "card--flat", className)} {...rest}>
      {title || action ? (
        <div className="card__head">
          {title ? <div className="card__title">{title}</div> : <span />}
          {action ?? null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
