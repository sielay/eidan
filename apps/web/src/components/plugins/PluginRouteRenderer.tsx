// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { pluginRoutes } from "@/plugins/registry.generated";

/**
 * Lazily mounts a plugin page resolved from the generated registry
 * (#284). Driven by the `/p/[plugin]/[[...slug]]` catch-all, which
 * already did the (plugin, path) lookup + `notFound()` server-side —
 * the `load` thunk isn't serialisable across the boundary, so we
 * re-resolve it here by the same key. The no-match branch is a
 * defensive `null` (the server route 404s before we get here).
 */

const lazyCache = new Map<string, React.LazyExoticComponent<React.ComponentType>>();

export function PluginRouteRenderer({
  plugin,
  path,
}: {
  plugin: string;
  path: string;
}) {
  const match = pluginRoutes.find(
    (route) => route.plugin === plugin && route.path === path,
  );
  if (!match) {
    return null;
  }
  // Delimited cache key so distinct (plugin, path) pairs can't collide
  // (e.g. "ab" + "/c" vs "a" + "b/c"). "::" can't occur in a plugin
  // slug or a route path.
  const key = `${plugin}::${path}`;
  let Component = lazyCache.get(key);
  if (!Component) {
    Component = React.lazy(match.load);
    lazyCache.set(key, Component);
  }
  return (
    <React.Suspense
      fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}
    >
      <Component />
    </React.Suspense>
  );
}
