// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Eidan native shell (Capacitor) configuration.
 *
 * Eidan's web front door (apps/web) is a *server-rendered* Next.js app
 * (`output: "standalone"`), NOT a static export. A Capacitor app can either bundle
 * static `webDir` assets or point at a live `server.url`. Because the front door is a
 * server, the native shell loads it over the network from a configurable URL.
 *
 * The server URL MUST come from the operator's environment — it is NEVER hardcoded to
 * any host. This mirrors apps/web's own `NEXT_PUBLIC_EIDAN_BACKEND_URL` convention
 * (per-deploy choices come from env vars, see the repo's gitignored-config policy).
 *
 *   EIDAN_MOBILE_SERVER_URL=https://eidan.example.org pnpm --filter @eidandev/mobile sync
 *
 * If `EIDAN_MOBILE_SERVER_URL` is unset, no `server.url` is emitted. In that case the
 * shell falls back to whatever static assets are copied into `webDir` (see README — the
 * static path is unused by default for this server-rendered app, but kept so the config
 * is valid and `cap sync` succeeds).
 */

const serverUrl = process.env.EIDAN_MOBILE_SERVER_URL?.trim();

// Allow cleartext (http://) only when explicitly opted in for LAN/dev against a
// non-TLS host (e.g. a Pi on the local network). Never default this on.
const allowCleartext = process.env.EIDAN_MOBILE_ALLOW_CLEARTEXT === '1';

const config: CapacitorConfig = {
  // Reverse-DNS app id. Operators should override via a fork/env at native-add time;
  // kept generic here (no operator/bundle names).
  appId: process.env.EIDAN_MOBILE_APP_ID?.trim() || 'dev.eidan.app',
  appName: process.env.EIDAN_MOBILE_APP_NAME?.trim() || 'Eidan',

  // Placeholder web assets directory. The front door is server-rendered, so the shell
  // normally loads `server.url` instead. `webDir` must exist for `cap sync`; the seed
  // ships a minimal public/ fallback page.
  webDir: 'public',

  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: allowCleartext,
      }
    : {
        // No remote URL configured: keep cleartext off, rely on webDir fallback.
        androidScheme: 'https',
      },
};

export default config;
