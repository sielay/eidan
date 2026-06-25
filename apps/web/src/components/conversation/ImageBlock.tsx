// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

// Inline image preview for chat markdown (`![alt](url)` and data URLs). Click opens
// the full image in a new tab. Lazy-loaded and bounded so a large image / glue brand
// render doesn't blow out the message column.
export function ImageBlock({
  src,
  alt,
}: {
  src?: string | Blob;
  alt?: string;
}): React.ReactElement | null {
  const url = typeof src === "string" ? src : undefined;
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="my-2 block w-fit"
      title={alt || "Open image"}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt ?? ""}
        loading="lazy"
        className="max-h-96 max-w-full rounded-md border border-border"
      />
    </a>
  );
}
