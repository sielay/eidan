// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-bluesky` plugin: post/search/read on Bluesky (AT Protocol). Accounts are connected in
// the Connections screen (handle + app password + optional service URL) — the app password is sealed
// in the vault per account; the registry lives in plugin_social_bluesky.accounts. Tools resolve a
// connected account at call time and mint a session JWT from its app password. Bluesky has no OAuth,
// so this plugin runs NO kit OAuth server. Falls back to the legacy BLUESKY_HANDLE /
// BLUESKY_APP_PASSWORD secrets when no account is registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, registerSocialConnection, startOAuthServer, type SealFn } from '@eidandev/connections-kit';
import { makeBlueskyTools } from './tools.js';
import { BLUESKY_PROVIDER, blueskyAdapter } from './adapter.js';

// Re-declared (matbot registry idiom) so the plugin needs no hard dep on core's vault implementation.
interface SecretField { name: string; label: string; secret?: boolean; required?: boolean; help?: string }
interface SecretSection { plugin: string; title: string; fields: SecretField[] }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: {
      declareSection(section: SecretSection): void;
      setSecret(name: string, value: string): Promise<void>;
    };
  }
}

const SCHEMA = 'plugin_social_bluesky';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Bluesky Social: post, search, and read the feed (bluesky_post, bluesky_search, bluesky_read_feed) ' +
      "across the operator's connected Bluesky accounts (managed in Connections; handle + app password " +
      'sealed per-account in the vault, no OAuth).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeBlueskyTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected handle without importing this plugin's DB.
      await registerSocialConnection(services, BLUESKY_PROVIDER, registry);
      services.tools.register(makeAccountsTool(BLUESKY_PROVIDER, registry));
      // No OAuth connect flow, but the kit server still serves the "Test" probe (start/finish unused).
      const port = Number(process.env['MATBOT_SOCIAL_BLUESKY_OAUTH_PORT'] ?? 8107);
      stopOAuthServer = startOAuthServer(services, registry, blueskyAdapter, {
        port,
        prefix: '/api/me/social-bluesky/oauth',
      });
      console.log(`[social-bluesky] plugin loaded (app-password; test probe on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeBlueskyTools(null, seal)) services.tools.register(t);
      console.log('[social-bluesky] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-bluesky',
      title: 'Bluesky Social',
      fields: [
        {
          name: 'BLUESKY_HANDLE',
          label: 'Bluesky Handle (legacy)',
          help: 'Legacy single-account fallback. Prefer connecting an account under Connections. Your handle (e.g. user.bsky.social).',
        },
        {
          name: 'BLUESKY_APP_PASSWORD',
          label: 'App Password (legacy)',
          secret: true,
          help: 'Legacy single-account fallback. App password (NOT your login password). Generate at https://bsky.app/settings/app-passwords',
        },
        {
          name: 'BLUESKY_SERVICE',
          label: 'Service URL (legacy)',
          help: 'Optional: custom AT Protocol service (default: https://bsky.social)',
        },
      ],
    });
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
