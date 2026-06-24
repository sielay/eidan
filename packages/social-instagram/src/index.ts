// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-instagram` plugin: post/search/read on Instagram. Accounts are connected in the
// Connections screen (BYO OAuth2 client) — the client and the access token are sealed in the vault
// per account; the registry lives in plugin_social_instagram.accounts. Tools resolve a connected
// account at call time. Falls back to the legacy INSTAGRAM_ACCESS_TOKEN secret when no account is
// registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, startOAuthServer, registerSocialConnection, type SealFn } from '@eidandev/connections-kit';
import { makeInstagramTools } from './tools.js';
import { instagramAdapter, INSTAGRAM_PROVIDER } from './adapter.js';

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

const SCHEMA = 'plugin_social_instagram';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Instagram Social: post to Instagram, search hashtags, read your feed, and get your profile ' +
      '(instagram_post_feed, instagram_search, instagram_list_feed, instagram_get_profile) across the ' +
      "operator's connected Instagram accounts (managed in Connections; BYO OAuth2 client, tokens sealed " +
      'per-account in the vault).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeInstagramTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected handle without importing this plugin's DB.
      await registerSocialConnection(services, INSTAGRAM_PROVIDER, registry);
      services.tools.register(makeAccountsTool(INSTAGRAM_PROVIDER, registry));
      // Server-side connect/reconnect (write-only vault → engine rebuilds consent).
      const port = Number(process.env['MATBOT_SOCIAL_INSTAGRAM_OAUTH_PORT'] ?? 8102);
      stopOAuthServer = startOAuthServer(services, registry, instagramAdapter, { port, prefix: '/api/me/social-instagram/oauth' });
      console.log(`[social-instagram] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeInstagramTools(null, seal)) services.tools.register(t);
      console.log('[social-instagram] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-instagram',
      title: 'Instagram Social',
      fields: [
        {
          name: 'INSTAGRAM_ACCESS_TOKEN',
          label: 'Instagram Graph API Access Token (legacy)',
          secret: true,
          help: 'Legacy single-account fallback. Prefer connecting an account under Connections (BYO OAuth client).',
        },
      ],
    });
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
