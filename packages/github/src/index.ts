// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `github` plugin: read repos/files/issues/PRs, search code, create issues on GitHub.
// Accounts are connected in the Connections screen (PAT only) — the PAT is sealed in the vault
// per account; the registry lives in plugin_github.accounts. Tools resolve a connected account at
// call time and use the PAT directly. GitHub has no OAuth for PATs, so this plugin runs NO kit
// OAuth server for connect flows, but does start the test probe server. Falls back to the legacy
// GITHUB_TOKEN secret when no account is registered.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeAccountsTool, Registry, registerSocialConnection, startOAuthServer } from '@eidandev/connections-kit';
import { makeGitHubTools } from './tools.js';
import { GITHUB_PROVIDER, githubAdapter } from './adapter.js';

// Re-declared (matbot registry idiom) so the plugin needs no hard dep on core's vault implementation.
interface SecretField { name: string; label: string; secret?: boolean; required?: boolean; help?: string }
interface SecretSection { plugin: string; title: string; fields: SecretField[] }
type SealFn = (name: string, value: string) => Promise<void>;
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: {
      declareSection(section: SecretSection): void;
      setSecret(name: string, value: string): Promise<void>;
    };
  }
}

const SCHEMA = 'plugin_github';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'GitHub: read repos and files, list issues and pull requests, search code, and create issues ' +
      "across the operator's connected GitHub accounts (managed in Connections; PAT sealed per-account " +
      'in the vault, no OAuth).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const t of makeGitHubTools(registry, seal)) services.tools.register(t);
      // Let Charles validate a connected GitHub account without importing this plugin's DB.
      await registerSocialConnection(services, GITHUB_PROVIDER, registry);
      services.tools.register(makeAccountsTool(GITHUB_PROVIDER, registry));
      // No OAuth connect flow, but the kit server still serves the "Test" probe (start/finish unused).
      const port = Number(process.env['MATBOT_GITHUB_OAUTH_PORT'] ?? 8110);
      stopOAuthServer = startOAuthServer(services, registry, githubAdapter, {
        port,
        prefix: '/api/me/github/oauth',
      });
      console.log(`[github] plugin loaded (app-password; PAT-based; test probe on :${port})`);
    } else {
      // No DB: legacy single-secret mode only.
      for (const t of makeGitHubTools(null, seal)) services.tools.register(t);
      console.log('[github] plugin loaded (legacy single-secret mode — no database)');
    }

    services.EidanSecrets?.declareSection({
      plugin: 'github',
      title: 'GitHub',
      fields: [
        {
          name: 'GITHUB_TOKEN',
          label: 'GitHub Token (legacy)',
          secret: true,
          help: 'Legacy single-account fallback. Personal Access Token. Prefer connecting an account under Connections. Generate at https://github.com/settings/tokens',
        },
      ],
    });
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
