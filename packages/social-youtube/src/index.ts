// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `social-youtube` plugin: comment/search/read on YouTube. Accounts are connected in the
// Connections screen (BYO Google OAuth2 client, offline access) — the client and the access/refresh
// tokens are sealed in the vault per account; the registry lives in plugin_social_youtube.accounts.
// Tools resolve a connected account at call time and refresh its token transparently. Falls back to
// the legacy YOUTUBE_ACCESS_TOKEN secret when no account is registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, startOAuthServer, registerSocialConnection, type SealFn } from '@eidandev/connections-kit';
import { makeYoutubeTools } from './tools.js';
import { youtubeAdapter, YOUTUBE_PROVIDER } from './adapter.js';

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

const SCHEMA = 'plugin_social_youtube';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'YouTube Social: post comments, search videos, read channel and uploaded videos (youtube_post_comment, ' +
      'youtube_search, youtube_get_channel, youtube_list_videos) across the operator\'s connected YouTube ' +
      'accounts (managed in Connections; BYO Google OAuth2 client, tokens sealed per-account in the vault, ' +
      'auto-refreshed).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeYoutubeTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected handle without importing this plugin's DB.
      await registerSocialConnection(services, YOUTUBE_PROVIDER, registry);
      services.tools.register(makeAccountsTool(YOUTUBE_PROVIDER, registry));
      // Server-side connect/reconnect (write-only vault → engine rebuilds consent, holds PKCE verifier).
      const port = Number(process.env['MATBOT_SOCIAL_YOUTUBE_OAUTH_PORT'] ?? 8106);
      stopOAuthServer = startOAuthServer(services, registry, youtubeAdapter, { port, prefix: '/api/me/social-youtube/oauth' });
      console.log(`[social-youtube] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeYoutubeTools(null, seal)) services.tools.register(t);
      console.log('[social-youtube] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'social-youtube',
      title: 'YouTube Social',
      fields: [
        {
          name: 'YOUTUBE_ACCESS_TOKEN',
          label: 'YouTube API Access Token (legacy)',
          secret: true,
          help: 'Legacy single-account fallback. Prefer connecting an account under Connections (BYO Google OAuth client).',
        },
      ],
    });
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
