// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-mastodon` plugin: post/search/read on Mastodon (federated). Accounts are connected in
// the Connections screen — Mastodon has no operator-supplied client, so the kit registers an OAuth app
// with each instance on demand (flavor 'dynamic_app') and caches it per host. Each account's access
// token is sealed in the vault; the registry lives in plugin_social_mastodon.accounts (with a per-host
// app-credential cache). Tools resolve a connected account at call time and build a client from its
// token + host. Falls back to the legacy MASTODON_INSTANCE + MASTODON_ACCESS_TOKEN secrets when no
// account is registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, startOAuthServer, registerSocialConnection, type SealFn } from '@eidandev/connections-kit';
import { makeMastodonTools } from './tools.js';
import { mastodonAdapter, MASTODON_PROVIDER } from './adapter.js';

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

const SCHEMA = 'plugin_social_mastodon';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Mastodon Social: post toots, search, read profiles and timelines (mastodon_post, mastodon_search, ' +
      'mastodon_get_profile, mastodon_list_timeline) across the operator\'s connected Mastodon accounts ' +
      '(managed in Connections; federated — the kit registers an OAuth app with each instance on demand ' +
      'and caches it per host, tokens sealed per-account in the vault).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA, hasHost: true });
      await registry.ensureSchema();
      for (const t of makeMastodonTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected handle without importing this plugin's DB.
      await registerSocialConnection(services, MASTODON_PROVIDER, registry);
      services.tools.register(makeAccountsTool(MASTODON_PROVIDER, registry));
      // Server-side connect/reconnect (write-only vault → engine rebuilds consent, registers per-host app).
      const port = Number(process.env['MATBOT_SOCIAL_MASTODON_OAUTH_PORT'] ?? 8104);
      stopOAuthServer = startOAuthServer(services, registry, mastodonAdapter, {
        port,
        prefix: '/api/me/social-mastodon/oauth',
      });
      console.log(`[social-mastodon] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeMastodonTools(null, seal)) services.tools.register(t);
      console.log('[social-mastodon] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-mastodon',
      title: 'Mastodon Social',
      fields: [
        {
          name: 'MASTODON_INSTANCE',
          label: 'Mastodon Instance (legacy)',
          help: 'Legacy single-account fallback. Your Mastodon instance domain (e.g., mastodon.social). Prefer connecting an account under Connections.',
        },
        {
          name: 'MASTODON_ACCESS_TOKEN',
          label: 'Access Token (legacy)',
          secret: true,
          help: 'Legacy single-account fallback. Prefer connecting an account under Connections.',
        },
      ],
    });
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
