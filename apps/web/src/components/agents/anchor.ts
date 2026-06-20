// SPDX-License-Identifier: AGPL-3.0-or-later
// Position a floating overlay near an anchor rect: flip above when there's no room below, clamp to
// the viewport horizontally, and — on narrow screens — become a full-width sheet pinned to the bottom
// of the *visual* viewport (so the on-screen keyboard doesn't cover it). Fixes both the bottom-of-
// screen clipping on desktop and basic usability on mobile.

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
}

const MARGIN = 8;
const MOBILE_MAX = 640;

export function placeAnchored(el: HTMLElement, anchor: AnchorRect): void {
  const vw = window.innerWidth;
  const vv = window.visualViewport;
  const vh = vv?.height ?? window.innerHeight;
  const vTop = vv?.offsetTop ?? 0;
  el.style.position = "fixed";

  if (vw < MOBILE_MAX) {
    // Full-width sheet at the bottom of the visible area (above the keyboard).
    const h = el.offsetHeight || 320;
    el.style.left = `${MARGIN}px`;
    el.style.right = `${MARGIN}px`;
    el.style.width = "auto";
    el.style.maxHeight = "60vh";
    el.style.overflowY = "auto";
    el.style.top = `${Math.max(MARGIN, vTop + vh - h - MARGIN)}px`;
    return;
  }

  el.style.right = "auto";
  el.style.width = "";
  el.style.maxHeight = "";
  el.style.overflowY = "";
  const h = el.offsetHeight || 280;
  const w = el.offsetWidth || 320;
  const roomBelow = vTop + vh - anchor.bottom;
  const top = roomBelow >= h + MARGIN ? anchor.bottom + 4 : Math.max(vTop + MARGIN, anchor.top - h - 4);
  el.style.top = `${top}px`;
  el.style.left = `${Math.max(MARGIN, Math.min(anchor.left, vw - w - MARGIN))}px`;
}
