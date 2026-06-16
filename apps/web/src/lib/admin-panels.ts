// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure parser for the EIDAN_ADMIN_PANELS env (operator-declared admin cursor panels). Kept free of
// Next / `@/` imports so it is unit-testable in isolation. See docs/0007-admin-panels.md.

export interface PanelRef {
  plugin: string;
  prefix: string;
}

// "name=/prefix, /bare-prefix" → [{plugin,prefix}]. A bare prefix derives its name from the last
// path segment. Entries without a leading-slash prefix (or no name) are dropped.
export function parsePanels(raw: string | undefined): PanelRef[] {
  if (!raw || !raw.trim()) return [];
  const out: PanelRef[] = [];
  for (const entry of raw.split(",")) {
    const t = entry.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    const plugin = eq >= 0 ? t.slice(0, eq).trim() : t.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? t;
    const prefix = (eq >= 0 ? t.slice(eq + 1).trim() : t).replace(/\/+$/, "");
    if (plugin && prefix.startsWith("/")) out.push({ plugin, prefix });
  }
  return out;
}
