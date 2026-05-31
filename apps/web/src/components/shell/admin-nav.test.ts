// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_NAV_LINKS } from "./admin-nav";

const ADMIN_DIR = join(
  __dirname,
  "..",
  "..",
  "app",
  "(main)",
  "admin",
);

function walkPageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkPageFiles(full));
    } else if (entry === "page.tsx") {
      out.push(full);
    }
  }
  return out;
}

function routePathFor(pageFile: string): string {
  const rel = relative(ADMIN_DIR, pageFile)
    .split(sep)
    .slice(0, -1)
    .join("/");
  return rel ? `/admin/${rel}` : "/admin";
}

function isReachable(routePath: string): boolean {
  return ADMIN_NAV_LINKS.some(
    (link) =>
      link.href === routePath || routePath.startsWith(`${link.href}/`),
  );
}

describe("ADMIN_NAV_LINKS", () => {
  it("covers every admin page under apps/web/src/app/(main)/admin", () => {
    const pages = walkPageFiles(ADMIN_DIR);
    expect(pages.length).toBeGreaterThan(0);

    const unreachable = pages
      .map(routePathFor)
      .filter((route) => !isReachable(route));

    expect(
      unreachable,
      `admin page(s) not reachable through ADMIN_NAV_LINKS — add an entry to apps/web/src/components/shell/admin-nav.ts:\n  ${unreachable.join("\n  ")}`,
    ).toEqual([]);
  });

  it("declares non-empty href and label for each link", () => {
    for (const link of ADMIN_NAV_LINKS) {
      expect(link.href).toMatch(/^\/admin\//);
      expect(link.label.length).toBeGreaterThan(0);
    }
  });
});
