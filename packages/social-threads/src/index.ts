// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-threads` plugin: post/search/read on Meta Threads. Accounts are connected in the
// Connections screen (BYO OAuth2 client) — the client and the access token are sealed in the vault
// per account; the registry lives in plugin_social_threads.accounts. Tools resolve a connected
// account at call time. Falls back to the legacy THREADS_ACCESS_TOKEN secret when no account is
// registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, startOAuthServer, registerSocialConnection, type SealFn } from '@eidandev/connections-kit';
import { makeThreadsTools } from './tools.js';
import { threadsAdapter, THREADS_PROVIDER } from './adapter.js';

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

const SCHEMA = 'plugin_social_threads';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Threads Social: post to Threads, search posts, get profile, and read timeline ' +
      '(threads_post_thread, threads_search, threads_get_profile, threads_list_timeline) across the ' +
      "operator's connected Threads accounts (managed in Connections; BYO OAuth2 client, tokens " +
      'sealed per-account in the vault).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeThreadsTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected handle without importing this plugin's DB.
      await registerSocialConnection(services, THREADS_PROVIDER, registry);
      services.tools.register(makeAccountsTool(THREADS_PROVIDER, registry));
      // Server-side connect/reconnect (write-only vault → engine rebuilds consent).
      const port = Number(process.env['MATBOT_SOCIAL_THREADS_OAUTH_PORT'] ?? 8105);
      stopOAuthServer = startOAuthServer(services, registry, threadsAdapter, { port, prefix: '/api/me/social-threads/oauth' });
      console.log(`[social-threads] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeThreadsTools(null, seal)) services.tools.register(t);
      console.log('[social-threads] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-threads',
      title: 'Threads Social',
      fields: [
        {
          name: 'THREADS_ACCESS_TOKEN',
          label: 'Threads Access Token (legacy)',
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
