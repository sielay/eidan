"use client";

import type { PluginSummary } from "@/lib/api/plugins";

/**
 * Tier ordering for the sidebar's grouped plugin list. Core renders
 * first regardless of how many plugins each tier has — operators
 * expect the canonical tier to lead the list.
 */
export const TIER_ORDER: PluginSummary["tier"][] = [
  "core",
  "pro",
  "commercial",
];

/**
 * Group a flat plugin list by ``tier`` and return the buckets in
 * canonical order with each bucket sorted by ``display_name``.
 *
 * Empty tiers are omitted from the result so the caller doesn't
 * have to filter them.
 *
 * Extracted from ``shell/PluginList.tsx`` so unit tests can exercise
 * the data-shaping logic without dragging React + the auth
 * provider into the test process.
 */
export function groupByTier(
  plugins: PluginSummary[],
): { tier: PluginSummary["tier"]; rows: PluginSummary[] }[] {
  const buckets = new Map<PluginSummary["tier"], PluginSummary[]>();
  for (const p of plugins) {
    const list = buckets.get(p.tier) ?? [];
    list.push(p);
    buckets.set(p.tier, list);
  }
  return TIER_ORDER.filter((t) => buckets.has(t)).map((tier) => ({
    tier,
    rows: (buckets.get(tier) ?? []).slice().sort((a, b) =>
      a.display_name.localeCompare(b.display_name),
    ),
  }));
}
