// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MetadataRoute } from "next";

// Web app manifest, served by Next at /manifest.webmanifest via the App Router
// file convention. Kept generic (no operator/host strings) — colours come from
// the design system (`--accent`, `--bg`). Icons are SVG (any + maskable); drop
// in raster artwork under public/icons and extend this list to customise.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "eidan",
    short_name: "eidan",
    description: "Self-hosted personal agent host.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#FBFBFA",
    theme_color: "#4F46E5",
    icons: [
      {
        src: "/icons/icon.svg",
        type: "image/svg+xml",
        sizes: "any",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable.svg",
        type: "image/svg+xml",
        sizes: "any",
        purpose: "maskable",
      },
    ],
  };
}
