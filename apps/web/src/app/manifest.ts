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
      // SVG scales to any launcher size on browsers that accept it (Chrome/desktop).
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
      // Raster fallbacks for platforms/installability checks that require PNG
      // (iOS, some Android launchers, Lighthouse). Regenerate with
      // `pnpm --filter @eidandev/mobile exec node scripts/gen-icons.mjs`.
      { src: "/icons/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
      { src: "/icons/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        type: "image/png",
        sizes: "512x512",
        purpose: "maskable",
      },
    ],
  };
}
