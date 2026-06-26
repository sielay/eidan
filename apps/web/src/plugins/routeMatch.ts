// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PluginRoute } from "@/plugins/registry.generated";

/**
 * Resolve a (plugin, path) request to a registered plugin route.
 *
 * Matching is exact-first. A route whose path ends in `/*` is a
 * wildcard that ALSO serves any sub-path beneath its prefix, so a
 * plugin can own slug/path-based sub-pages from a single route — e.g.
 * charles-ventures serves both `/p/charles-ventures` and
 * `/p/charles-ventures/<venture-slug>` from one `"/*"` route, the
 * component reading the slug from the pathname. The longest matching
 * prefix wins, and an exact route always beats a wildcard. Returns
 * null when nothing matches (the caller 404s).
 *
 * Keeping this rule in one place means the server catch-all (which
 * decides `notFound()`) and the client renderer (which resolves the
 * lazy `load`) can never disagree about what a path resolves to.
 */
export function matchPluginRoute(
  routes: readonly PluginRoute[],
  plugin: string,
  path: string,
): PluginRoute | null {
  const mine = routes.filter((r) => r.plugin === plugin);
  const exact = mine.find((r) => r.path === path);
  if (exact) return exact;
  let best: PluginRoute | null = null;
  let bestLen = -1;
  for (const r of mine) {
    if (!r.path.endsWith("/*")) continue;
    // "/*" -> "/" (matches anything); "/foo/*" -> "/foo" (matches /foo and /foo/...).
    const prefix = r.path.slice(0, -2) || "/";
    const under = prefix === "/" || path === prefix || path.startsWith(prefix + "/");
    if (under && prefix.length > bestLen) {
      best = r;
      bestLen = prefix.length;
    }
  }
  return best;
}
