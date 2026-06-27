// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

// Shared markdown <a> renderer: an `eidan:type:id` href (a resolved @-mention token) renders as an inline
// chip rather than a broken link; everything else is a normal external link. Used by every surface that
// renders markdown which may contain mentions (chat messages, file view, memory).
export function MentionAnchor({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
  if (typeof href === "string" && href.startsWith("eidan:")) {
    const type = href.split(":")[1] ?? "ref";
    return (
      <span className="eidan-mention" title={href} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "0 5px", borderRadius: 5, background: "var(--accent-soft, rgba(99,102,241,0.14))", color: "var(--accent-link, #4f46e5)", fontSize: "0.92em", fontWeight: 500, whiteSpace: "nowrap" }}>
        <span aria-hidden style={{ opacity: 0.7 }}>@</span>{children}<span aria-hidden style={{ opacity: 0.5, fontSize: "0.8em", textTransform: "uppercase" }}>{type}</span>
      </span>
    );
  }
  return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}
