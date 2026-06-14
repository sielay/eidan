// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { startSecretsApi } from './server.js';

// The AG-UI front door (frontend-agui) reverse-proxies registered path prefixes to internal plugin
// ports, so :8092 need not be exposed publicly. Re-declared here (the matbot decoupling pattern; the
// string key matches at runtime) — absent ⇒ this server is only reachable on its own loopback port.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    PanelProxy?: { register(route: { prefix: string; port: number }): void };
  }
}

let stop: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Secure secrets HTTP API (the LLM-free write path): GET /api/me/secrets (metadata) + /catalog (declared sections), PUT/DELETE /api/me/secrets/:name. Values enter server-side under the Bearer-resolved Principal and are sealed into eidan.secrets_vault — never shown to a model. Backed by the EidanSecrets service (@eidandev/vault-postgres). Port via MATBOT_SECRETS_PORT (default 8092).',
  },
  async setup(services: MatbotServices) {
    services.registerFrontend({ name: 'secrets-api' });
    const port = Number(process.env['MATBOT_SECRETS_PORT'] ?? 8092);
    const webOrigin = process.env['EIDAN_DEV_WEB_ORIGIN'];
    stop = startSecretsApi(services, { port, ...(webOrigin !== undefined ? { webOrigin } : {}) });
    // Expose this server through the public AG-UI port: GET/PUT/DELETE /api/me/secrets/* reach it via
    // the front door, so the web app proxies to one engine URL and :8092 stays internal.
    services.PanelProxy?.register({ prefix: '/api/me/secrets', port });
    console.log(`[secrets-api] on :${port} (secure secret entry; values never reach the LLM)`);
  },
  async teardown() {
    if (stop) stop();
  },
};
