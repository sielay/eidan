// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Local DiceBear avatars — generated in-process from a seed (no CDN/API call), so no identifier ever
// leaves the deployment. Style is pickable (see AVATAR_STYLES); the seed is randomisable. Falls back
// to a per-kind default (agent → bottts, user → thumbs) when no explicit style is set. Used in chat,
// board cards, jobs, comments, and the Agents UI.
import { createAvatar } from "@dicebear/core";
import {
  avataaars,
  bottts,
  funEmoji,
  identicon,
  lorelei,
  micah,
  notionists,
  pixelArt,
  shapes,
  thumbs,
} from "@dicebear/collection";
import * as React from "react";

// Each style has its own Options type, so a unioned `style` var won't typecheck against createAvatar —
// wrap each in a concrete closure instead.
const STYLES: Record<string, (seed: string, size: number) => string> = {
  bottts: (seed, size) => createAvatar(bottts, { seed, size }).toString(),
  thumbs: (seed, size) => createAvatar(thumbs, { seed, size }).toString(),
  avataaars: (seed, size) => createAvatar(avataaars, { seed, size }).toString(),
  "fun-emoji": (seed, size) => createAvatar(funEmoji, { seed, size }).toString(),
  shapes: (seed, size) => createAvatar(shapes, { seed, size }).toString(),
  identicon: (seed, size) => createAvatar(identicon, { seed, size }).toString(),
  lorelei: (seed, size) => createAvatar(lorelei, { seed, size }).toString(),
  notionists: (seed, size) => createAvatar(notionists, { seed, size }).toString(),
  "pixel-art": (seed, size) => createAvatar(pixelArt, { seed, size }).toString(),
  micah: (seed, size) => createAvatar(micah, { seed, size }).toString(),
};

// The styles offered in the picker, with friendly labels.
export const AVATAR_STYLES: Array<[string, string]> = [
  ["bottts", "Bottts"],
  ["thumbs", "Thumbs"],
  ["avataaars", "Avataaars"],
  ["fun-emoji", "Fun emoji"],
  ["lorelei", "Lorelei"],
  ["notionists", "Notionists"],
  ["micah", "Micah"],
  ["pixel-art", "Pixel art"],
  ["shapes", "Shapes"],
  ["identicon", "Identicon"],
];

export function avatarDataUri(seed: string, style: string, size = 64): string {
  const render = STYLES[style] ?? STYLES.thumbs!;
  return `data:image/svg+xml;utf8,${encodeURIComponent(render(seed || style, size))}`;
}

export function Avatar({
  seed,
  style,
  kind = "user",
  size = 22,
  title,
}: {
  seed: string;
  style?: string | null;
  kind?: "user" | "agent";
  size?: number;
  title?: string;
}): React.ReactElement {
  const resolved = (style && STYLES[style] ? style : kind === "agent" ? "bottts" : "thumbs");
  const uri = React.useMemo(() => avatarDataUri(seed, resolved, size), [seed, resolved, size]);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- inline data URI, not a network image
    <img src={uri} alt="" title={title} width={size} height={size} style={{ borderRadius: "50%", flexShrink: 0, display: "block" }} />
  );
}
