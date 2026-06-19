// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shell navigation model.
 *
 * Sections are CONTRIBUTED by installed bundles — the design's
 * "the shell computes the rail + bottom bar from whichever bundles are
 * installed" (UI_DESIGN_BRIEF §4). Public core ships only the core
 * sections + the merge mechanism; paid bundles inject their own
 * sections at runtime (so bundle-private naming never lands in core).
 *
 * From the merged catalogue the shell derives two surfaces:
 * - the desktop **rail** — Chat pinned at top, then domain groups, then
 *   the System group (Memory / Plugins / Admin), Settings at the foot.
 * - the mobile **bottom bar** — Chat + the highest-priority domain homes
 *   (by `mobileHome`), with everything else under "More".
 */

export type NavIconKey =
  | "chat"
  | "memory"
  | "inbox"
  | "plugins"
  | "admin"
  | "settings"
  | "more"
  | "plus"
  | "search"
  | "sun"
  | "moon"
  | "chevron";

export interface NavSection {
  id: string;
  label: string;
  // Core keys autocomplete; plugins may contribute their own icon name (NavIcon
  // falls back to a generic glyph for an unknown key).
  icon: NavIconKey | (string & {});
  href: string;
  /** Lower = promoted to the mobile bottom bar sooner; null = More/rail only. */
  mobileHome: number | null;
  /** Rendered only at desktop widths (operator ops panels). */
  desktopOnly?: boolean;
  /** The bundle that contributed this section (for rail grouping). */
  bundle: string;
  /** Group heading on the desktop rail. */
  group: string;
}

/** A bundle's contribution to the shell nav. */
export interface NavContribution {
  bundle: string;
  group: string;
  sections: Omit<NavSection, "bundle" | "group">[];
}

/** Core sections — always present, real routes. */
export const CORE_CONTRIBUTION: NavContribution = {
  bundle: "core",
  group: "System",
  sections: [
    { id: "chat", label: "Chat", icon: "chat", href: "/", mobileHome: 0 },
    { id: "memory", label: "Memory", icon: "memory", href: "/memory", mobileHome: 1 },
    { id: "inbox", label: "Inbox", icon: "inbox", href: "/escalations", mobileHome: 2 },
    { id: "agents", label: "Agents", icon: "agents", href: "/agents", mobileHome: null },
    { id: "plugins", label: "Plugins", icon: "plugins", href: "/plugins", mobileHome: 3 },
    { id: "admin", label: "Admin", icon: "admin", href: "/admin/activity", mobileHome: null, desktopOnly: true },
  ],
};

/** The Settings section sits at the foot of the rail, outside groups. */
export const SETTINGS_SECTION: NavSection = {
  id: "settings",
  label: "Settings",
  icon: "settings",
  href: "/settings",
  mobileHome: null,
  bundle: "core",
  group: "System",
};

/** Flatten contributions into resolved sections (chat first). */
export function resolveSections(
  contributions: readonly NavContribution[] = [CORE_CONTRIBUTION],
): NavSection[] {
  return contributions.flatMap((c) =>
    c.sections.map((s) => ({ ...s, bundle: c.bundle, group: c.group })),
  );
}

export interface RailGroup {
  key: string;
  label: string;
  sections: NavSection[];
}

/** The Chat section, pinned standalone at the top of the rail. */
export function chatSection(sections: NavSection[]): NavSection | undefined {
  return sections.find((s) => s.id === "chat");
}

/**
 * Rail groups: domain bundles first (in contribution order), the core
 * System group last. Chat is excluded (pinned separately); Settings is
 * excluded (rendered at the foot).
 */
export function railGroups(sections: NavSection[]): RailGroup[] {
  const order: string[] = [];
  const byBundle = new Map<string, NavSection[]>();
  for (const s of sections) {
    if (s.id === "chat") continue;
    if (!byBundle.has(s.bundle)) {
      byBundle.set(s.bundle, []);
      order.push(s.bundle);
    }
    byBundle.get(s.bundle)!.push(s);
  }
  // Core last.
  order.sort((a, b) => (a === "core" ? 1 : 0) - (b === "core" ? 1 : 0));
  return order.map((bundle) => ({
    key: bundle,
    label: byBundle.get(bundle)![0].group,
    sections: byBundle.get(bundle)!,
  }));
}

/** Mobile bottom bar: Chat + up to 3 highest-priority domain homes. */
export function bottomTabs(sections: NavSection[]): NavSection[] {
  const chat = chatSection(sections);
  const homes = sections
    .filter((s) => s.id !== "chat" && s.mobileHome !== null && !s.desktopOnly)
    .sort((a, b) => (a.mobileHome ?? 99) - (b.mobileHome ?? 99))
    .slice(0, 3);
  return chat ? [chat, ...homes] : homes;
}

/** Everything reachable from the mobile "More" sheet (excludes Chat). */
export function moreSections(sections: NavSection[]): NavSection[] {
  const inBar = new Set(bottomTabs(sections).map((s) => s.id));
  return [...sections.filter((s) => s.id !== "chat" && !inBar.has(s.id)), SETTINGS_SECTION];
}

/**
 * Active-section match for a pathname. Chat ("/") matches exactly or any
 * `/c/...` conversation route; other sections match by href prefix.
 */
export function isActive(section: NavSection, pathname: string): boolean {
  if (section.href === "/") return pathname === "/" || pathname.startsWith("/c");
  return pathname === section.href || pathname.startsWith(section.href + "/");
}
