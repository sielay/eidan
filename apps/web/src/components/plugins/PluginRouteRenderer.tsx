// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { notFound } from "next/navigation";
import * as React from "react";

import { pluginRoutes } from "@/plugins/registry.generated";

/**
 * Resolves a plugin page from the generated registry and renders it
 * lazily (#284). Driven by the `/p/[plugin]/[[...slug]]` catch-all.
 * An unknown (plugin, path) pair 404s.
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
    notFound();
  }
  const key = `${plugin}${path}`;
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
