// SPDX-License-Identifier: AGPL-3.0-or-later
// Small human "when" formatter shared by the memory routes (notes "updated", events "when").
export function relTime(v: unknown): string {
  if (!v) return "";
  const t = new Date(String(v)).getTime();
  if (!t) return "";
  const diff = Date.now() - t; // >0 past, <0 future
  const past = diff >= 0;
  const s = Math.abs(diff) / 1000;
  const d = Math.floor(s / 86400);
  if (s < 60) return past ? "just now" : "in a moment";
  if (s < 3600) {
    const m = Math.round(s / 60);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (s < 86400) {
    const h = Math.round(s / 3600);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  if (d === 1) return past ? "yesterday" : "tomorrow";
  if (d < 7) return past ? `${d} days ago` : `in ${d} days`;
  if (d < 30) {
    const w = Math.round(d / 7);
    return past ? `${w} week${w > 1 ? "s" : ""} ago` : `in ${w} week${w > 1 ? "s" : ""}`;
  }
  const mo = Math.round(d / 30);
  return past ? `${mo} month${mo > 1 ? "s" : ""} ago` : `in ${mo} month${mo > 1 ? "s" : ""}`;
}
