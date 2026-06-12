// SPDX-License-Identifier: AGPL-3.0-or-later
import * as React from "react";
import { cx } from "./cx";

/**
 * EmptyState — consistent empty layout with a single CTA (design §2/§3),
 * never half-built filler.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cx("empty", className)}>
      {icon ? <div className="empty__icon">{icon}</div> : null}
      <div className="empty__title">{title}</div>
      {body ? <div className="empty__body">{body}</div> : null}
      {action}
    </div>
  );
}
