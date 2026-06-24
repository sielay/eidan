// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-facebook` plugin: post/search/read on Facebook. Accounts are connected in the
// Connections screen (BYO OAuth2 client) — the client and the access token are sealed in the vault
// per account; the registry lives in plugin_social_facebook.accounts. Tools resolve a connected
// account at call time. Falls back to the legacy FACEBOOK_ACCESS_TOKEN secret when no account is
// registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, startOAuthServer, registerSocialConnection, type SealFn } from '@eidandev/connections-kit';
import { makeFacebookTools } from './tools.js';
import { facebookAdapter, FACEBOOK_PROVIDER } from './adapter.js';

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

const SCHEMA = 'plugin_social_facebook';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Facebook Social: post to Facebook, search posts, read feed, and get profile (facebook_post_feed, ' +
      'facebook_search, facebook_get_profile, facebook_list_feed) across the operator\'s connected ' +
      'Facebook accounts (managed in Connections; BYO OAuth2 client, tokens sealed per-account in the vault).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeFacebookTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected handle without importing this plugin's DB.
      await registerSocialConnection(services, FACEBOOK_PROVIDER, registry);
      services.tools.register(makeAccountsTool(FACEBOOK_PROVIDER, registry));
      // Server-side connect/reconnect (write-only vault → engine rebuilds consent).
      const port = Number(process.env['MATBOT_SOCIAL_FACEBOOK_OAUTH_PORT'] ?? 8101);
      stopOAuthServer = startOAuthServer(services, registry, facebookAdapter, { port, prefix: '/api/me/social-facebook/oauth' });
      console.log(`[social-facebook] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeFacebookTools(null, seal)) services.tools.register(t);
      console.log('[social-facebook] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-facebook',
      title: 'Facebook Social',
      fields: [
        {
          name: 'FACEBOOK_ACCESS_TOKEN',
          label: 'Access Token (legacy)',
          secret: true,
          help: 'Legacy single-account fallback. Prefer connecting an account under Connections (BYO OAuth client).',
        },
        {
          name: 'FACEBOOK_PAGE_ID',
          label: 'Page ID (Optional)',
          help: 'Facebook Page ID to post as a page instead of personal profile. Leave blank to post to personal feed.',
        },
      ],
    });
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
