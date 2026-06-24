// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-x` plugin: post/search/read on X (Twitter). Accounts are connected in the Connections
// screen (BYO OAuth2 client + PKCE) — the client and the access/refresh tokens are sealed in the vault
// per account; the registry lives in plugin_social_x.accounts. Tools resolve a connected account at
// call time and refresh its token transparently. Falls back to the legacy X_ACCESS_TOKEN secret when
// no account is registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, startOAuthServer, registerSocialConnection, type SealFn } from '@eidandev/connections-kit';
import { makeXTools } from './tools.js';
import { xAdapter, X_PROVIDER } from './adapter.js';

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

const SCHEMA = 'plugin_social_x';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'X (Twitter) Social: post tweets, search, read profile and timeline (x_post_tweet, x_search, ' +
      'x_get_profile, x_list_timeline) across the operator\'s connected X accounts (managed in ' +
      'Connections; BYO OAuth2 client + PKCE, tokens sealed per-account in the vault, auto-refreshed).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeXTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected handle without importing this plugin's DB.
      await registerSocialConnection(services, X_PROVIDER, registry);
      services.tools.register(makeAccountsTool(X_PROVIDER, registry));
      // Server-side connect/reconnect (write-only vault → engine rebuilds consent, holds PKCE verifier).
      const port = Number(process.env['MATBOT_SOCIAL_X_OAUTH_PORT'] ?? 8100);
      stopOAuthServer = startOAuthServer(services, registry, xAdapter, { port, prefix: '/api/me/social-x/oauth' });
      console.log(`[social-x] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeXTools(null, seal)) services.tools.register(t);
      console.log('[social-x] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-x',
      title: 'X (Twitter) Social',
      fields: [
        {
          name: 'X_ACCESS_TOKEN',
          label: 'X API Access Token (legacy)',
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
