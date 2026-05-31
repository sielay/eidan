// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sidebar entries for the "Admin" section.
 *
 * Mirrors the admin routes from `docs/014 §3` that have a built
 * page. New admin pages MUST appear here (or under an existing
 * entry's prefix) — `admin-nav.test.ts` walks the
 * `apps/web/src/app/(main)/admin` tree and fails the build if a
 * `page.tsx` is not reachable through one of these links.
 *
 * `/admin/mcp` (docs/013 §9.2) is added when its page lands.
 */
export type AdminNavLink = {
  readonly href: string;
  readonly label: string;
};

export const ADMIN_NAV_LINKS: readonly AdminNavLink[] = [
  { href: "/admin/activity", label: "Activity" },
];
