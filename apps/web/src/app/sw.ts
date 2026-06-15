// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
//
// The eidan service worker (compiled by @serwist/next into public/sw.js).
//
// Strategy summary:
//   - Precache the app shell + build assets (self.__SW_MANIFEST, injected at
//     build time) so the UI chrome loads offline.
//   - Network-first for navigations and the chat/turn + data APIs, since the
//     agent and dashboards are inherently online; fall back to the cached shell
//     or the dedicated /offline page when the network is unavailable.
//   - Stale-while-revalidate / cache-first for static assets and fonts.
//
// The chat itself needs the network: when offline it shows a friendly "you're
// offline" state rather than a broken page (see /offline + the chat UI).
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  Serwist,
  StaleWhileRevalidate,
} from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// The offline fallback document, precached so it is always available.
const OFFLINE_URL = "/offline";

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Auth + data + chat-turn endpoints: always try the network first; never
    // serve a stale agent answer or stale dashboard. Short-lived cache only so
    // a flaky connection can still render the last-known dashboard data.
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/"),
      handler: new NetworkFirst({
        cacheName: "eidan-api",
        networkTimeoutSeconds: 10,
        plugins: [
          new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 60 * 5 }),
        ],
      }),
    },
    // Next static build output is content-hashed and immutable.
    {
      matcher: ({ url, sameOrigin }) =>
        sameOrigin && url.pathname.startsWith("/_next/static/"),
      handler: new CacheFirst({
        cacheName: "eidan-next-static",
        plugins: [
          new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 60 * 60 * 24 * 30 }),
        ],
      }),
    },
    // App icons + other public assets.
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/icons/"),
      handler: new StaleWhileRevalidate({ cacheName: "eidan-icons" }),
    },
    // Google Fonts CSS + woff2 (next/font/google).
    {
      matcher: ({ url }) =>
        url.origin === "https://fonts.googleapis.com" ||
        url.origin === "https://fonts.gstatic.com",
      handler: new StaleWhileRevalidate({ cacheName: "eidan-fonts" }),
    },
    // Everything else falls back to serwist's sensible defaults (images, JS,
    // styles, same-origin navigations as network-first).
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: OFFLINE_URL,
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();
