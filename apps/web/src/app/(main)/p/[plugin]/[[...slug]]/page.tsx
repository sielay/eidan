// SPDX-License-Identifier: AGPL-3.0-or-later
import { PluginRouteRenderer } from "@/components/plugins/PluginRouteRenderer";

/**
 * Catch-all host route for plugin pages (#284): every plugin
 * `frontend.routes[]` entry is served under `/p/<plugin>/<path>`.
 * The slug is reassembled into the manifest's route path and resolved
 * against the generated registry by the client renderer.
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
  return <PluginRouteRenderer plugin={plugin} path={path} />;
}
