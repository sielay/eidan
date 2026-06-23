// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { PluginSummary } from "@/lib/api/plugins";
import { TIER_ORDER, groupByTier } from "./plugin-grouping";

function plugin(
  partial: Partial<PluginSummary> & Pick<PluginSummary, "tier" | "display_name">,
): PluginSummary {
  return {
    name: partial.display_name.toLowerCase().replace(/\s+/g, "-"),
    display_name: partial.display_name,
    tier: partial.tier,
    version: partial.version ?? "0.1.0",
    description: partial.description ?? null,
    enabled: partial.enabled ?? true,
  };
}

describe("groupByTier", () => {
  it("returns canonical tier order: core → bundle → matbot", () => {
    const out = groupByTier([
      plugin({ tier: "matbot", display_name: "Acme" }),
      plugin({ tier: "core", display_name: "Capture" }),
      plugin({ tier: "bundle", display_name: "Calendar" }),
    ]);
    expect(out.map((b) => b.tier)).toEqual(["core", "bundle", "matbot"]);
  });

  it("sorts each tier alphabetically by display_name", () => {
    const out = groupByTier([
      plugin({ tier: "core", display_name: "Zoo" }),
      plugin({ tier: "core", display_name: "Capture" }),
      plugin({ tier: "core", display_name: "Alpha" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rows.map((r) => r.display_name)).toEqual([
      "Alpha",
      "Capture",
      "Zoo",
    ]);
  });

  it("omits empty tiers", () => {
    const out = groupByTier([
      plugin({ tier: "core", display_name: "Capture" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("core");
  });

  it("returns an empty list when given no plugins", () => {
    expect(groupByTier([])).toEqual([]);
  });

  it("preserves all rows even when one tier has many", () => {
    const out = groupByTier([
      plugin({ tier: "core", display_name: "A" }),
      plugin({ tier: "core", display_name: "B" }),
      plugin({ tier: "core", display_name: "C" }),
      plugin({ tier: "bundle", display_name: "D" }),
    ]);
    expect(out[0].rows).toHaveLength(3);
    expect(out[1].rows).toHaveLength(1);
  });

  it("uses TIER_ORDER as the canonical ordering", () => {
    expect(TIER_ORDER).toEqual(["core", "bundle", "matbot"]);
  });
});
