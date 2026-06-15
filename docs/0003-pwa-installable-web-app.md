<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0003 — PWA (installable web app)

Status: **Shipped** — the `apps/web` Next.js front door is an installable Progressive Web App.

## Goal

Let an operator install eidan to their home screen and launch it like a native app —
standalone window, app icon, an offline shell — from Android, desktop Chrome/Edge, or iOS
Safari, with no app store. The PWA is **always on in production builds**; there is no env
var to toggle and nothing for an operator to configure.

## The three pieces

| Piece | File | Role |
|---|---|---|
| Manifest | `apps/web/src/app/manifest.ts` | Next 15 App Router manifest, served at `/manifest.webmanifest`. |
| Service worker | `apps/web/src/app/sw.ts` | Serwist SW source, compiled to `public/sw.js` at build. |
| Build integration | `apps/web/next.config.ts` | `withSerwistInit()` compiles the SW and injects the precache manifest. |

Built on **Serwist** (`@serwist/next` + `serwist`, the modern Workbox successor).

## Manifest

```
name / short_name: "eidan"
description:        "Self-hosted personal agent host."
id / start_url / scope: "/"
display:           "standalone"
orientation:       "portrait-primary"
background_color:  "#FBFBFA"
theme_color:       "#4F46E5"
icons:             /icons/icon.svg (any) + /icons/icon-maskable.svg (maskable)
                   + PNG raster: icon-192, icon-512, icon-maskable-512, apple-touch-icon (180)
```

Icons are SVG (`apps/web/public/icons/`), so they scale to any launcher size; the maskable
variant insets the glyph in the safe zone so platform masks never reveal transparent corners.
PNG raster variants are also shipped for platforms that require them (iOS home-screen / apple-
touch-icon, some Android launchers, Lighthouse installability) — generated from the same glyph by
`apps/mobile/scripts/gen-icons.mjs` (see `0006-native-app-wrapper.md`).

## Service worker — caching strategy

The SW is registered client-side by `components/pwa/ServiceWorkerRegistrar.tsx`
(`navigator.serviceWorker.register("/sw.js", { scope: "/" })`), deferred until the document
is `complete` so it never competes with first paint. Strategies:

- **Precache (app shell):** `self.__SW_MANIFEST`, injected at build time — the Next build
  assets + UI chrome.
- **`/api/*` → network-first** (10s timeout, 5-min expiry, ≤64 entries). The agent's answers
  and live dashboards must never be served stale.
- **`/_next/static/*` → cache-first** (content-hashed, immutable; 30-day expiry, ≤128 entries).
- **`/icons/*` + Google Fonts → stale-while-revalidate.**
- **Document-navigation fallback → the precached `/offline` page** when the network is down.

Lifecycle: `skipWaiting` + `clientsClaim` + `navigationPreload` for instant activation, and
`reloadOnOnline: true` so open clients auto-reload when a new SW activates — a deploy reaches
users without a manual refresh.

## Install flow

- **Android / desktop Chrome/Edge:** the browser fires `beforeinstallprompt`;
  `components/pwa/InstallPrompt.tsx` captures it and shows a dismissible "Install app" chip
  (dismissal remembered in `localStorage` under `eidan-pwa-install-dismissed`). Already-installed
  is detected via `(display-mode: standalone)` and the chip hides.
- **iOS Safari:** no `beforeinstallprompt` — install is the native Share → *Add to Home
  Screen*. The root layout sets `appleWebApp: { capable: true, statusBarStyle: "default",
  title: "eidan" }`; installed state is detected via `navigator.standalone`.
- **Offline:** `components/pwa/OfflineNotice.tsx` watches `navigator.onLine` and shows a calm
  "you're offline" notice with a one-tap reload when the connection returns. The `/offline`
  route is `force-static` and precached.

## Dev vs. prod

The SW is **disabled in development** (`disable: process.env.NODE_ENV === "development"` in
`next.config.ts`) and any stale SW is unregistered on dev runs, so HMR stays clean. In
production it is compiled into `public/sw.js` with the precache manifest baked in. The base
`nextConfig` keeps `output: "standalone"` for the Docker image.

## Files of record

- `apps/web/src/app/manifest.ts`, `apps/web/src/app/sw.ts`, `apps/web/next.config.ts`
- `apps/web/src/components/pwa/` — `ServiceWorkerRegistrar`, `InstallPrompt`, `OfflineNotice`
- `apps/web/public/icons/icon.svg`, `apps/web/public/icons/icon-maskable.svg`
