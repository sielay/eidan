// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-tiktok` plugin: read profile + own videos, and publish a video from a public URL on
// TikTok. Accounts are connected in the Connections screen (BYO TikTok Login Kit client_key +
// client_secret) — the client and the access/refresh tokens are sealed in the vault per account; the
// registry lives in plugin_social_tiktok.accounts. Tools resolve a connected account at call time and
// refresh its token transparently. Falls back to the legacy TIKTOK_ACCESS_TOKEN secret when no
// account is registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, startOAuthServer, registerSocialConnection, type SealFn } from '@eidandev/connections-kit';
import { makeTiktokTools } from './tools.js';
import { tiktokAdapter, TIKTOK_PROVIDER } from './adapter.js';

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

const SCHEMA = 'plugin_social_tiktok';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'TikTok Social: read profile + own videos, and publish a video from a public URL ' +
      '(tiktok_get_profile, tiktok_list_videos, tiktok_post_video) across the operator\'s connected ' +
      'TikTok accounts (managed in Connections; BYO TikTok Login Kit client, tokens sealed per-account ' +
      'in the vault, auto-refreshed).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeTiktokTools(registry, seal)) services.tools.register(t);
      await registerSocialConnection(services, TIKTOK_PROVIDER, registry);
      services.tools.register(makeAccountsTool(TIKTOK_PROVIDER, registry));
      // Server-side connect/reconnect (write-only vault → engine rebuilds consent).
      const port = Number(process.env['MATBOT_SOCIAL_TIKTOK_OAUTH_PORT'] ?? 8110);
      stopOAuthServer = startOAuthServer(services, registry, tiktokAdapter, { port, prefix: '/api/me/social-tiktok/oauth' });
      console.log(`[social-tiktok] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeTiktokTools(null, seal)) services.tools.register(t);
      console.log('[social-tiktok] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-tiktok',
      title: 'TikTok Social',
      fields: [
        {
          name: 'TIKTOK_ACCESS_TOKEN',
          label: 'TikTok API Access Token (legacy)',
          secret: true,
          help: 'Legacy single-account fallback. Prefer connecting an account under Connections (BYO TikTok Login Kit client).',
        },
      ],
    });
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
