// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Registry } from './registry.js';
import { makeLogTools } from './tools.js';
import { startLogsTestServer } from './test-server.js';

// eidan-sage `logs` plugin: read deployment/app logs from the operator's named log sources (Vercel +
// Fly + Heroku + Better Stack to start). Each source's provider + non-secret config lives in
// plugin_logs.sources (managed in the Integrations → Logs screen); only the API token is sealed in
// the vault, per user. Adding a platform is a new provider module — see src/providers/. Logs are
// read live and never stored.
let registry: Registry | undefined;
let stopTestServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Logs: read deployment/app logs from the operator\'s named sources — Vercel, Fly, Heroku, ' +
      'Better Stack (logs_list_sources / logs_read). Sources are managed in Integrations → Logs; ' +
      'API tokens sealed in the vault, per-user.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) {
      throw new Error(
        'EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/logs (it owns the plugin_logs source registry)',
      );
    }
    registry = new Registry(url);
    await registry.ensureSchema();
    for (const tool of makeLogTools(registry)) services.tools.register(tool);

    // Engine-side "test source" endpoint, exposed through the AG-UI front door via PanelProxy
    // (reachable from the web admin screen at /api/logs/test).
    const port = Number(process.env['EIDAN_LOGS_TEST_PORT'] ?? 8097);
    stopTestServer = startLogsTestServer(services, registry, port);
  },
  async teardown() {
    if (stopTestServer) stopTestServer();
    if (registry) await registry.close();
  },
};
