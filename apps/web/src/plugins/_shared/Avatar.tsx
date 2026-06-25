// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Local DiceBear avatars — generated in-process from a seed (no CDN/API call), so no identifier ever
// leaves the deployment. Agents get a 'bottts' robot face; people get 'thumbs'. Used in chat, board
// cards, jobs and comments. Memoised per (seed, kind, size).
import { createAvatar } from "@dicebear/core";
import { bottts, thumbs } from "@dicebear/collection";
import * as React from "react";

export function Avatar({
  seed,
  kind = "user",
  size = 22,
  title,
}: {
  seed: string;
  kind?: "user" | "agent";
  size?: number;
  title?: string;
}): React.ReactElement {
  const uri = React.useMemo(() => {
    // Separate calls per style — each DiceBear style has its own Options type, so a unioned `style`
    // var doesn't typecheck against createAvatar.
    const svg = kind === "agent"
      ? createAvatar(bottts, { seed: seed || kind, size }).toString()
      : createAvatar(thumbs, { seed: seed || kind, size }).toString();
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }, [seed, kind, size]);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- inline data URI, not a network image
    <img src={uri} alt="" title={title} width={size} height={size} style={{ borderRadius: "50%", flexShrink: 0, display: "block" }} />
  );
}
