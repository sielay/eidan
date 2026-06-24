// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, ToolContext } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Registry, startOAuthServer, type SealFn } from '@eidandev/connections-kit';
import { makeGmailTools, resolveFromRegistry } from './tools.js';
import { googleAdapter } from './adapter.js';

// Optional integration with the eidan secrets catalog (@eidandev/vault-postgres): declare the
// credentials this plugin needs so Settings → Connections renders a secure section for them.
// Structurally re-declared (matbot registry idiom) so the bundle needs no hard dep on core.
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

// Cross-plugin sharing (matbot service-registry idiom): expose the registry-resolved connected
// Google account so other plugins (e.g. gdrive) reuse it — one connected account, many APIs, as
// long as the consent grant carried the scope each needs. Structurally re-declared so neither side
// needs a hard dep on the other; the string service key matches at runtime.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    GoogleConnection?: { resolveCreds(ctx: ToolContext): Promise<{ clientId: string; clientSecret: string; refreshToken: string } | null> };
  }
}

// eidan `google` plugin: read the operator's Gmail via OAuth2 on the shared connections kit. Accounts
// are connected in the Connections screen (the plugin's frontend manifest) — the OAuth client
// id/secret + refresh token are sealed in the vault per account, the registry lives in
// plugin_google.accounts. Each call mints a short-lived access token from the stored refresh token.
// Read-only; nothing stored beyond the registry. Falls back to legacy EIDAN_GOOGLE_* secrets when no
// account is registered.
const SCHEMA = 'plugin_google';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Google (Gmail): read-through Gmail access over OAuth2 (gmail_list_recent + gmail_read) across ' +
      'the operator\'s connected accounts (managed in the Connections screen; client + refresh token ' +
      'sealed in the vault, per-user), refreshing a short-lived token per call.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const tool of makeGmailTools(registry, seal)) services.tools.register(tool);

      // Expose the registry-resolved connected account so other plugins (e.g. gdrive) reuse it. No
      // legacy fallback here — that stays gmail-private inside the tools; the shared surface is the
      // connected-account path only, returning null when nothing is connected.
      const reg = registry;
      await services.register('GoogleConnection', { resolveCreds: (ctx) => resolveFromRegistry(reg, ctx) });

      // Server-side connect/reconnect: the web is a write-only vault client and can't read the sealed
      // OAuth client back to rebuild the consent URL or exchange the code — the engine can. Expose the
      // endpoints behind the AG-UI panel-proxy.
      const port = Number(process.env['MATBOT_GOOGLE_OAUTH_PORT'] ?? 8094);
      stopOAuthServer = startOAuthServer(services, registry, googleAdapter, { port, prefix: '/api/me/google/oauth' });
      console.log(`[google] plugin loaded (oauth on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const tool of makeGmailTools(null, seal)) services.tools.register(tool);
      // The shared connected-account surface has nothing to resolve without a registry.
      await services.register('GoogleConnection', { resolveCreds: async () => null });
      console.log('[google] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'google',
      title: 'Google (Gmail)',
      fields: [
        { name: 'EIDAN_GOOGLE_CLIENT_ID', label: 'OAuth client ID', required: true, help: 'From Google Cloud Console → Credentials. Used for the legacy single-account fallback; connect accounts under Connections instead.' },
        { name: 'EIDAN_GOOGLE_CLIENT_SECRET', label: 'OAuth client secret', secret: true, required: true },
        { name: 'EIDAN_GOOGLE_REFRESH_TOKEN', label: 'OAuth refresh token', secret: true, required: true, help: 'Obtained via the OAuth consent flow with the gmail.readonly scope.' },
      ],
    });
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
