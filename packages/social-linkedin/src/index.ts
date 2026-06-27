// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-linkedin` plugin: post/search/profile/feed on LinkedIn. Accounts are connected in the
// Connections screen (BYO OAuth2 client) — the client and the access token are sealed in the vault per
// account; the registry lives in plugin_social_linkedin.accounts. Tools resolve a connected account at
// call time. Falls back to the legacy LINKEDIN_ACCESS_TOKEN secret when no account is registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, startOAuthServer, registerSocialConnection, type SealFn } from '@eidandev/connections-kit';
import { makeLinkedinTools } from './tools.js';
import { linkedinAdapter, LINKEDIN_PROVIDER } from './adapter.js';

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

const SCHEMA = 'plugin_social_linkedin';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'LinkedIn Social: post to LinkedIn, read profile and list your own posts ' +
      '(linkedin_post, linkedin_get_profile, linkedin_list_feed) across the operator\'s connected ' +
      'LinkedIn accounts (managed in Connections; BYO OAuth2 client, tokens sealed per-account in the vault). ' +
      'Note: engagement metrics currently unavailable due to API permission restrictions (requires standard tier).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeLinkedinTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected handle without importing this plugin's DB.
      await registerSocialConnection(services, LINKEDIN_PROVIDER, registry);
      services.tools.register(makeAccountsTool(LINKEDIN_PROVIDER, registry));
      // Server-side connect/reconnect (write-only vault → engine rebuilds consent).
      const port = Number(process.env['MATBOT_SOCIAL_LINKEDIN_OAUTH_PORT'] ?? 8103);
      stopOAuthServer = startOAuthServer(services, registry, linkedinAdapter, { port, prefix: '/api/me/social-linkedin/oauth' });
      console.log(`[social-linkedin] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeLinkedinTools(null, seal)) services.tools.register(t);
      console.log('[social-linkedin] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-linkedin',
      title: 'LinkedIn Social',
      fields: [
        {
          name: 'LINKEDIN_ACCESS_TOKEN',
          label: 'LinkedIn Access Token (legacy)',
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
