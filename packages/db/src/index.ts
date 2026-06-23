// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Registry } from './registry.js';
import { makeDbTools } from './tools.js';
import { startDbTestServer } from './test-server.js';

// eidan-sage `db` plugin: connect to the operator's named databases (Postgres + MongoDB to start)
// and run read/write queries. Each connection's non-secret coordinates (driver/host/port/database/
// username) live in plugin_db.connections (managed in the Integrations → Databases screen); only the
// password is sealed in the vault, per user. Adding an engine is a new driver module — see
// src/drivers/. Nothing about a queried database is stored beyond the registry; queries run live.
let registry: Registry | undefined;
let stopTestServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Databases: connect to the operator\'s named Postgres/MongoDB databases and run read/write ' +
      'queries (db_list_connections / db_inspect / db_query / db_mongo). Connections are managed in ' +
      'Integrations → Databases; passwords sealed in the vault, per-user.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) {
      throw new Error(
        'EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/db (it owns the plugin_db connection registry)',
      );
    }
    registry = new Registry(url);
    await registry.ensureSchema();
    for (const tool of makeDbTools(registry)) services.tools.register(tool);

    // Engine-side "test connection" endpoint, exposed through the AG-UI front door via PanelProxy
    // (reachable from the web admin screen at /api/db/test). None-safe: with no PanelProxy/resolver
    // the server still listens on its private port, just isn't proxied.
    const port = Number(process.env['EIDAN_DB_TEST_PORT'] ?? 8096);
    stopTestServer = startDbTestServer(services, registry, port);
  },
  async teardown() {
    if (stopTestServer) stopTestServer();
    if (registry) await registry.close();
  },
};
