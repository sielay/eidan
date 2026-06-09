// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from "next/navigation";

import { PluginRouteRenderer } from "@/components/plugins/PluginRouteRenderer";
import { pluginRoutes } from "@/plugins/registry.generated";

/**
 * Catch-all host route for plugin pages (#284): every plugin
 * `frontend.routes[]` entry is served under `/p/<plugin>/<path>`.
 *
 * The (plugin, path) lookup + the 404 decision happen HERE, in the
 * server component — `notFound()` is only supported server-side. The
 * client renderer then lazily mounts the matched component (the `load`
 * thunk isn't serialisable across the server→client boundary, so the
 * client re-resolves it by the same key).
 *
 * (Next 15: `params` is a Promise.)
 */
export default async function PluginCatchAllPage({
  params,
}: {
  params: Promise<{ plugin: string; slug?: string[] }>;
}) {
  const { plugin, slug } = await params;
  const path = "/" + (slug ?? []).join("/");
  const match = pluginRoutes.find(
    (route) => route.plugin === plugin && route.path === path,
  );
  if (!match) {
    notFound();
  }
  return <PluginRouteRenderer plugin={plugin} path={path} />;
}
