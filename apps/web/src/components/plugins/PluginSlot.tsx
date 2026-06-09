// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { pluginSlots } from "@/plugins/registry.generated";

/**
 * Renders every plugin component registered for a named slot (#284).
 *
 * Host UI drops `<PluginSlot name="dashboard.widget" />` at a stable
 * extension point; the build-context assembly populates the registry
 * with whichever active plugins target that slot. Empty in the base
 * (no-plugin-frontends) build, so the host renders nothing extra.
 */

// Module-level cache so a given slot component is wrapped in React.lazy
// once, not re-created each render (which would remount it).
const slotCache = new Map<string, React.LazyExoticComponent<React.ComponentType>>();

export function PluginSlot({ name }: { name: string }) {
  const entries = pluginSlots.filter((entry) => entry.slot === name);
  if (entries.length === 0) {
    return null;
  }
  return (
    <>
      {entries.map((entry, index) => {
        // Include the index: a plugin may register several distinct
        // components for one slot, so plugin:slot alone would alias them.
        const key = `${entry.plugin}::${entry.slot}::${index}`;
        let Component = slotCache.get(key);
        if (!Component) {
          Component = React.lazy(entry.load);
          slotCache.set(key, Component);
        }
        return (
          <React.Suspense key={key} fallback={null}>
            <Component />
          </React.Suspense>
        );
      })}
    </>
  );
}
