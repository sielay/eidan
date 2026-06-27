// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shell navigation model.
 *
 * Sections are CONTRIBUTED by installed bundles — the design's
 * "the shell computes the rail + bottom bar from whichever bundles are
 * installed" (UI_DESIGN_BRIEF §4). Public core ships only the core
 * sections + the merge mechanism; opt-in bundles inject their own
 * sections at runtime (so plugin-private naming never lands in core).
 *
 * From the merged catalogue the shell derives two surfaces:
 * - the desktop **rail** — Chat pinned at top, then domain groups, then
 *   the System group (Memory / Plugins / Admin), Settings at the foot.
 * - the mobile **bottom bar** — Chat + the highest-priority domain homes
 *   (by `mobileHome`), with everything else under "More".
 */

// Keep in sync with the icon map in NavIcon.tsx. As this grows, consider refactoring
// to dynamically generate from the map to avoid manual duplication.
export type NavIconKey =
  | "chat"
  | "memory"
  | "agents"
  | "boards"
  | "escalations"
  | "skills"
  | "calendar"
  | "procedures"
  | "ventures"
  | "decision-log"
  | "jobs"
  | "files"
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
  group: "Work",
  sections: [
    { id: "chat", label: "Chat", icon: "chat", href: "/", mobileHome: 0 },
    { id: "escalations", label: "Escalations", icon: "escalations", href: "/escalations", mobileHome: 2 },
    { id: "agents", label: "Agents", icon: "agents", href: "/agents", mobileHome: null },
  ],
};

/** Tools & Knowledge sections. */
export const TOOLS_CONTRIBUTION: NavContribution = {
  bundle: "core",
  group: "Tools",
  sections: [
    { id: "memory", label: "Memory", icon: "memory", href: "/memory", mobileHome: 1 },
    { id: "files", label: "Files", icon: "files", href: "/files", mobileHome: null },
    { id: "jobs", label: "Jobs", icon: "jobs", href: "/jobs", mobileHome: null },
    { id: "procedures", label: "Procedures", icon: "procedures", href: "/procedures", mobileHome: null },
    { id: "plugins", label: "Plugins", icon: "plugins", href: "/plugins", mobileHome: 3 },
  ],
};

/** Admin sections. */
export const ADMIN_CONTRIBUTION: NavContribution = {
  bundle: "core",
  group: "System",
  sections: [
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

/** Flatten contributions into resolved sections, deduplicating by id (core contributions take precedence). */
export function resolveSections(
  contributions: readonly NavContribution[] = [CORE_CONTRIBUTION],
): NavSection[] {
  const sections = contributions.flatMap((c) =>
    c.sections.map((s) => ({ ...s, bundle: c.bundle, group: c.group })),
  );
  // Deduplicate by id: first occurrence wins (core contributions take precedence).
  const seen = new Set<string>();
  return sections.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
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
 * Rail groups: domain groups first (in first-seen contribution order), the
 * core System group last. Sections are merged by their `group` HEADING, not by
 * bundle — so several bundles all contributing to "Integrations" (Mail, Calendars,
 * Databases, Logs, …) render under ONE "Integrations" heading rather than a
 * separate header per bundle. Chat is excluded (pinned separately); Settings is
 * excluded (rendered at the foot).
 */
export function railGroups(sections: NavSection[]): RailGroup[] {
  const order: string[] = [];
  const byGroup = new Map<string, NavSection[]>();
  for (const s of sections) {
    if (s.id === "chat") continue;
    if (!byGroup.has(s.group)) {
      byGroup.set(s.group, []);
      order.push(s.group);
    }
    byGroup.get(s.group)!.push(s);
  }
  // The core "System" group always sorts last.
  order.sort((a, b) => (a === "System" ? 1 : 0) - (b === "System" ? 1 : 0));
  return order.map((group) => ({
    key: group,
    label: group,
    sections: byGroup.get(group)!,
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
